import { beforeEach, describe, expect, it } from 'vitest';
import { createVerifier, fakeControls, makeAttestation, resetFakeVerifier } from './fakeVerify.js';
import { FakeDiscordAdapter } from './helpers.js';
import { decideRoleAction, RoleSyncEngine } from '../src/roles.js';
import { InMemoryStore, type Binding } from '../src/store.js';
import { VerifyService, type VerifierLike } from '../src/verifyService.js';

const GUILD = 'guild-1';
const APP = '123456789012345678';
const BOT_USER = '987654321098765432';
const ROLE = 'role-1';

describe('decideRoleAction — the sync decision table (DESIGN §5.5)', () => {
  it('verified -> grant', () => {
    expect(decideRoleAction('verified')).toBe('grant');
  });
  it('invalid -> revoke', () => {
    expect(decideRoleAction('invalid')).toBe('revoke');
  });
  it('expired -> revoke', () => {
    expect(decideRoleAction('expired')).toBe('revoke');
  });
  it('unregistered -> revoke', () => {
    expect(decideRoleAction('unregistered')).toBe('revoke');
  });
  it('unknown -> keep (a failed check revokes nothing, ever)', () => {
    expect(decideRoleAction('unknown')).toBe('keep');
  });
});

describe('RoleSyncEngine', () => {
  let store: InMemoryStore;
  let adapter: FakeDiscordAdapter;
  let engine: RoleSyncEngine;
  const binding: Binding = {
    guildId: GUILD,
    applicationId: APP,
    attestationUrl: 'https://operator.example.com/attestation.json',
    payloadHash: null,
    boundVia: 'url',
    boundBy: 'user-1',
    boundAt: '2026-10-25T00:00:00.000Z',
    botUserId: BOT_USER,
  };

  beforeEach(() => {
    resetFakeVerifier('verified');
    store = new InMemoryStore();
    store.upsertGuildConfig({
      guildId: GUILD,
      roleId: ROLE,
      registryUrl: null,
      syncIntervalMinutes: 360,
      logChannelId: 'log-1',
    });
    store.upsertBinding(binding);
    adapter = new FakeDiscordAdapter();
    const service = new VerifyService({
      verifier: createVerifier() as unknown as VerifierLike,
      store,
      fetchJson: async () => makeAttestation(),
    });
    engine = new RoleSyncEngine({
      store,
      service,
      adapter,
      sleep: async () => undefined, // retry delay is instant in tests
      unknownRetryDelayMs: 0,
    });
  });

  it('grants the role when the binding verifies and the bot lacks it', async () => {
    const [report] = await engine.syncGuild(GUILD);
    expect(report).toMatchObject({ status: 'verified', action: 'grant', changed: true });
    expect(adapter.grants).toHaveLength(1);
    expect(adapter.grants[0]).toMatchObject({ userId: BOT_USER, roleId: ROLE });
    expect(await adapter.memberHasRole(GUILD, BOT_USER, ROLE)).toBe(true);
  });

  it('revokes the role when the attestation has expired', async () => {
    fakeControls.status = 'expired';
    adapter.giveRole(GUILD, BOT_USER);
    const [report] = await engine.syncGuild(GUILD);
    expect(report).toMatchObject({ status: 'expired', action: 'revoke', changed: true });
    expect(adapter.revokes).toHaveLength(1);
    expect(await adapter.memberHasRole(GUILD, BOT_USER, ROLE)).toBe(false);
  });

  it('revokes the role when the wallet turns out unregistered', async () => {
    fakeControls.status = 'unregistered';
    adapter.giveRole(GUILD, BOT_USER);
    const [report] = await engine.syncGuild(GUILD);
    expect(report).toMatchObject({ status: 'unregistered', action: 'revoke', changed: true });
    expect(adapter.revokes).toHaveLength(1);
  });

  it('on unknown: keeps the role, retries once, and warns instead of revoking', async () => {
    fakeControls.status = 'unknown';
    adapter.giveRole(GUILD, BOT_USER);
    const [report] = await engine.syncGuild(GUILD);
    expect(report).toMatchObject({ status: 'unknown', action: 'keep', changed: false });
    expect(report.unknownWarning).toBe(true);
    expect(adapter.revokes).toHaveLength(0);
    expect(adapter.grants).toHaveLength(0);
    expect(await adapter.memberHasRole(GUILD, BOT_USER, ROLE)).toBe(true);
    // Both the failed check and its retry are in the guild's history.
    expect(store.listCheckLog(GUILD, APP)).toHaveLength(2);
    expect(adapter.logLines.some((l) => l.line.includes('warning'))).toBe(true);
  });

  it('does not warn on a single isolated unknown applied directly', async () => {
    fakeControls.status = 'unknown';
    const service = new VerifyService({
      verifier: createVerifier() as unknown as VerifierLike,
      store,
      fetchJson: async () => makeAttestation(),
    });
    const outcome = await service.checkApplication(GUILD, APP);
    const first = await engine.applyOutcome(GUILD, binding, outcome);
    expect(first.unknownWarning).toBe(false);
    const second = await engine.applyOutcome(GUILD, binding, outcome);
    expect(second.unknownWarning).toBe(true);
    expect(adapter.revokes).toHaveLength(0);
  });
});
