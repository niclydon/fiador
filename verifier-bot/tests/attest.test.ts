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
  buildCommandDefinitions,
  handleAttest,
  handleFiadorStatus,
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

  it('a passing operator attestation does not bind an unproven application or grant a role', async () => {
    const { deps, store, adapter } = buildDeps();
    const reply = await handleAttest(
      makeCtx({ attestation: JSON.stringify(makeAttestation()) }),
      deps,
    );
    expect(reply.content).toContain('application is unproven');
    expect(reply.content).toContain('Nothing was bound');
    expect(reply.embeds?.[0].title).toContain('Application control unproven');

    const binding = store.getBinding(GUILD, APP);
    expect(binding).toBeNull();

    expect(adapter.grants).toHaveLength(0);

    const log = store.listCheckLog(GUILD, APP);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: 'verified', failures: [] });
    expect(log[0].humanHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a signed claim naming another bot, or a bot ID equal to the app ID, still cannot bind or grant', async () => {
    for (const claimedBotUserId of [BOT_USER, APP]) {
      const { deps, store, adapter } = buildDeps();
      const attestation = makeAttestation({
        extra: { discord_bot_user_id: claimedBotUserId },
      });
      const reply = await handleAttest(
        makeCtx({ attestation: JSON.stringify(attestation) }),
        deps,
      );
      expect(reply.embeds?.[0].color).toBe(0x6e6e73);
      expect(reply.content).toContain('control of that Discord application is unproven');
      expect(store.getBinding(GUILD, APP)).toBeNull();
      expect(adapter.grants).toHaveLength(0);
    }
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

describe('/fiador status — legacy claims', () => {
  const legacyBinding = (applicationId: string) => ({
    guildId: GUILD,
    applicationId,
    attestationUrl: 'https://operator.example.com/attestation.json',
    payloadHash: null,
    boundVia: 'url',
    boundBy: 'user-1',
    boundAt: '2026-10-25T00:00:00.000Z',
    botUserId: BOT_USER,
  });

  it('marks both checked and unchecked rows as unproven, without calling them bound bots', async () => {
    resetFakeVerifier('verified');
    const { deps, store } = buildDeps();
    for (const applicationId of [APP, '223456789012345678']) {
      store.upsertBinding(legacyBinding(applicationId));
    }
    await deps.service.checkApplication(GUILD, APP);

    const reply = await handleFiadorStatus(makeCtx(), deps);
    const lines = reply.content?.split('\n') ?? [];
    const claimLines = lines.filter((line) => line.startsWith('• Application '));
    expect(lines.some((line) => line.startsWith('Stored legacy operator claims: page 1 of 1'))).toBe(true);
    expect(lines).not.toContain('Bound bots:');
    expect(reply.content).toContain('ADMIN AUDIT REQUIRED');
    expect(reply.content).toContain('remove unsupported roles');
    expect(reply.content).toContain('admin must inspect all role holders');
    expect(reply.content).not.toMatch(/\b0 member\(s\)/);
    expect(claimLines).toHaveLength(2);
    for (const line of claimLines) {
      expect(line).toContain('application control unproven; no role automation');
    }
    expect(claimLines.some((line) => line.includes('last attestation check: **verified**'))).toBe(true);
    expect(claimLines.some((line) => line.includes('not checked yet'))).toBe(true);
  });

  it('pages every legacy claim while keeping each Discord response below 2000 characters', async () => {
    const { deps, store, adapter } = buildDeps();
    const applicationIds = Array.from({ length: 15 }, (_, i) => String(BigInt(APP) + BigInt(i)));
    for (const applicationId of applicationIds) {
      store.upsertBinding(legacyBinding(applicationId));
    }
    const pages = await Promise.all([1, 2, 3].map((page) =>
      handleFiadorStatus(makeCtx({ page: String(page) }), deps),
    ));
    expect(pages.map((reply) => reply.content?.match(/• Application /g)?.length)).toEqual([6, 6, 3]);
    for (const [index, reply] of pages.entries()) {
      expect(reply.content?.length).toBeLessThanOrEqual(2000);
      expect(reply.content).toContain(`page ${index + 1} of 3`);
      expect(reply.content).toContain('ADMIN AUDIT REQUIRED');
    }
    const allPageText = pages.map((reply) => reply.content).join('\n');
    for (const applicationId of applicationIds) {
      expect(allPageText).toContain(`Application ${applicationId} —`);
    }
    expect(adapter.grants).toHaveLength(0);
    expect(adapter.revokes).toHaveLength(0);
  });

  it('bounds a legacy row and registry value even when stored text is malformed', async () => {
    const { deps, store } = buildDeps();
    store.upsertBinding(legacyBinding('9'.repeat(1000)));
    store.upsertGuildConfig({
      guildId: GUILD,
      roleId: '4'.repeat(1000),
      registryUrl: 'https://example.com/' + 'x'.repeat(2000),
      syncIntervalMinutes: 360,
      logChannelId: null,
    });
    const reply = await handleFiadorStatus(makeCtx(), deps);
    expect(reply.content?.length).toBeLessThanOrEqual(2000);
    expect(reply.content).toContain('Stored legacy operator claims: page 1 of 1');
  });

  it('offers a page picker and describes claims without promising bindings or role sync', () => {
    const [fiador] = buildCommandDefinitions();
    const definition = JSON.stringify(fiador);
    expect(definition).toContain('Legacy claims page');
    expect(definition).toContain('manual role-audit warning');
    expect(definition).not.toContain('Show bound bots');
    expect(definition).not.toContain('registry, and sync');
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
    expect(reply.embeds?.[0].title).toContain('Application control unproven');
    expect(store.listCheckLog(GUILD, APP)).toHaveLength(1);
    expect(adapter.grants).toHaveLength(0);
    expect(adapter.revokes).toHaveLength(0);
  });
});
