import { beforeEach, describe, expect, it } from 'vitest';
import {
  createVerifier,
  fakeControls,
  makeAttestation,
  resetFakeVerifier,
} from './fakeVerify.js';
import { FakeDiscordAdapter, makeCtx } from './helpers.js';
import {
  AttemptRateLimiter,
  handleAttest,
  handleVerifyAgent,
  type CommandDeps,
} from '../src/commands.js';
import { RoleSyncEngine } from '../src/roles.js';
import { InMemoryStore } from '../src/store.js';
import { VerifyService, type VerifierLike } from '../src/verifyService.js';

const GUILD = 'guild-1';
const APP = '123456789012345678';
const BOT_USER = '987654321098765432';
const ROLE = 'role-1';

function buildDeps(): { deps: CommandDeps; store: InMemoryStore; adapter: FakeDiscordAdapter } {
  const store = new InMemoryStore();
  store.upsertGuildConfig({
    guildId: GUILD,
    roleId: ROLE,
    registryUrl: null,
    syncIntervalMinutes: 360,
    logChannelId: null,
  });
  const adapter = new FakeDiscordAdapter();
  const service = new VerifyService({
    verifier: createVerifier() as unknown as VerifierLike,
    store,
    fetchJson: async () => makeAttestation(),
  });
  const sync = new RoleSyncEngine({ store, service, adapter, sleep: async () => undefined });
  const deps: CommandDeps = {
    service,
    store,
    adapter,
    sync,
    rateLimiter: new AttemptRateLimiter(),
    defaultSyncIntervalMinutes: 360,
  };
  return { deps, store, adapter };
}

describe('/attest — the operator claim flow (DESIGN §5.2, §3.5)', () => {
  beforeEach(() => {
    resetFakeVerifier('verified');
  });

  it('on success: binds the application and grants the role', async () => {
    const { deps, store, adapter } = buildDeps();
    const reply = await handleAttest(
      makeCtx({ attestation: JSON.stringify(makeAttestation()) }),
      deps,
    );
    expect(reply.content).toContain('Bound application');
    expect(reply.content).toContain('granted');

    const binding = store.getBinding(GUILD, APP);
    expect(binding).not.toBeNull();
    expect(binding?.boundVia).toBe('paste');
    expect(binding?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(binding?.botUserId).toBe(BOT_USER);

    expect(adapter.grants).toHaveLength(1);
    expect(adapter.grants[0]).toMatchObject({ userId: BOT_USER, roleId: ROLE });

    const log = store.listCheckLog(GUILD, APP);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: 'verified', failures: [] });
    expect(log[0].humanHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('on failure: reports the failure sentence and stores no binding', async () => {
    fakeControls.status = 'invalid';
    const { deps, store, adapter } = buildDeps();
    const reply = await handleAttest(
      makeCtx({ attestation: JSON.stringify(makeAttestation()) }),
      deps,
    );
    expect(reply.content).toContain('did not verify');
    expect(reply.content).toContain('signature does not match');
    expect(store.getBinding(GUILD, APP)).toBeNull();
    expect(adapter.grants).toHaveLength(0);
    // The failed check is still in the guild's history.
    const log = store.listCheckLog(GUILD, APP);
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe('invalid');
  });

  it('rate-limits repeated attempts per user per guild', async () => {
    fakeControls.status = 'invalid';
    const { deps } = buildDeps();
    const ctx = () => makeCtx({ attestation: JSON.stringify(makeAttestation()) });
    for (let i = 0; i < 5; i++) {
      const reply = await handleAttest(ctx(), deps);
      expect(reply.content).not.toContain('Too many');
    }
    const sixth = await handleAttest(ctx(), deps);
    expect(sixth.content).toContain('Too many');
  });
});

describe('/verify-agent — one-off check, no state change', () => {
  beforeEach(() => {
    resetFakeVerifier('verified');
  });

  it('renders the result embed and writes exactly one check_log row', async () => {
    const { deps, store, adapter } = buildDeps();
    store.upsertBinding({
      guildId: GUILD,
      applicationId: APP,
      attestationUrl: 'https://operator.example.com/attestation.json',
      payloadHash: null,
      boundVia: 'url',
      boundBy: 'user-1',
      boundAt: '2026-10-25T00:00:00.000Z',
      botUserId: BOT_USER,
    });
    const reply = await handleVerifyAgent(makeCtx({ application_id: APP }), deps);
    expect(reply.ephemeral).toBe(true);
    expect(reply.embeds).toHaveLength(1);
    expect(reply.embeds?.[0].title).toContain('Verified');
    expect(store.listCheckLog(GUILD, APP)).toHaveLength(1);
    expect(adapter.grants).toHaveLength(0);
    expect(adapter.revokes).toHaveLength(0);
  });
});
