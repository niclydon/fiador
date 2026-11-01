import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { verifyMessage } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  AppAuthorityService,
  canonicalAuthorityMessage,
  parseAuthorityCallback,
  requireCallbackOrigin,
  type DiscordOAuthTransport,
} from '../src/appAuthority.js';
import { loadConfig } from '../src/config.js';
import { InMemoryStore, SqliteStore, type AuthoritySession } from '../src/store.js';
import { VerifyService, payloadHash, type VerifierLike } from '../src/verifyService.js';
import {
  AttemptRateLimiter,
  buildCommandDefinitions,
  handleFiadorAuthorityComplete,
  handleFiadorAuthoritySign,
  handleFiadorAuthorityStart,
  handleFiadorStatus,
  type CommandDeps,
} from '../src/commands.js';
import { RoleSyncEngine } from '../src/roles.js';
import { FakeDiscordAdapter, makeCtx } from './helpers.js';
import { createVerifier, hashHumanId, makeAttestation, resetFakeVerifier, SYNTHETIC_HUMAN_ID } from './fakeVerify.js';

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const APP = '333333333333333333';
const BOT = '444444444444444444';
const VERIFIER = '555555555555555555';
const OWNER = '666666666666666666';
const ATTESTATION_URL = 'https://operator.example.com/attestation.json';
const ORIGIN = 'https://fiador.example';
const ACCESS_TOKEN = ['test', 'oauth', 'token', 'value'].join('-');

const account = privateKeyToAccount(generatePrivateKey());
const otherAccount = privateKeyToAccount(generatePrivateKey());

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

interface TransportCall { url: string; body?: string }

function fixture() {
  let now = new Date('2026-10-26T20:00:00.000Z');
  let fill = 0;
  let attestation = makeAttestation({
    subject: { type: 'discord_application', id: APP },
    agentWalletAddress: account.address,
    attestationUrl: ATTESTATION_URL,
    extra: { discord_bot_user_id: BOT, human_id_hash: hashHumanId(SYNTHETIC_HUMAN_ID) },
  });
  const store = new InMemoryStore();
  const adapter = new FakeDiscordAdapter();
  adapter.ownBotId = VERIFIER;
  adapter.channelGuildId = GUILD;
  adapter.integrations = [{ type: 'discord', enabled: true, application: { id: APP, bot: { id: BOT } } }];
  const verify = new VerifyService({
    verifier: createVerifier() as unknown as VerifierLike,
    store,
    fetchJson: async (url) => {
      if (url === ATTESTATION_URL) return attestation;
      throw new Error('Unexpected test URL.');
    },
  });
  const calls: TransportCall[] = [];
  let exchangeBody: unknown = { token_type: 'Bearer', access_token: ACCESS_TOKEN, scope: 'identify' };
  let meBody: unknown = { application: { id: APP }, user: { id: OWNER }, scopes: ['identify'] };
  const fetchDiscord: DiscordOAuthTransport = async (url, init) => {
    calls.push({ url, body: init.body });
    if (url.endsWith('/oauth2/token')) return jsonResponse(exchangeBody, (exchangeBody as { token_type?: string })?.token_type === 'Bearer');
    return jsonResponse(meBody);
  };
  const service = new AppAuthorityService({
    service: verify, store, adapter,
    verifyWalletSignature: async (wallet, text, signature) => verifyMessage({ address: wallet, message: text, signature }),
    callbackOrigin: ORIGIN,
    fetchDiscord,
    now: () => now,
    entropy: (size) => Buffer.alloc(size, ++fill % 250 + 1),
  });
  return {
    store, adapter, verify, service, calls,
    setNow(value: string) { now = new Date(value); },
    setAttestation(value: typeof attestation) { attestation = value; },
    setExchangeBody(value: unknown) { exchangeBody = value; },
    setMeBody(value: unknown) { meBody = value; },
    async startAndSign() {
      const start = await service.start(GUILD, CHANNEL, ATTESTATION_URL);
      const session = store.getAuthoritySession(start.proofId) as AuthoritySession;
      const signature = await account.signMessage({ message: canonicalAuthorityMessage(session) });
      const sign = await service.sign(GUILD, start.proofId, signature);
      return { start, sign, session };
    },
    callbackUrl(proofId: string, overrides: Record<string, string> = {}) {
      const session = store.getAuthoritySession(proofId) as AuthoritySession;
      const params = new URLSearchParams({
        code: 'test-authorization-code',
        state: overrides.state ?? session.oauthState,
        iss: overrides.iss ?? 'https://discord.com',
      });
      const base = overrides.base ?? session.callbackUri;
      return `${base}?${params.toString()}`;
    },
  };
}

beforeEach(() => resetFakeVerifier('verified'));

describe('application-authority ceremony', () => {
  it('completes the happy path and records team-grade authority without keeping the token', async () => {
    const f = fixture();
    const { start, sign, session } = await f.startAndSign();
    expect(start.callbackUri).toBe(`${ORIGIN}/app-authority/callback/${start.proofId}`);
    expect(start.message).toContain(`Wallet: ${account.address}`);
    expect(start.message).toContain(`Discord application ID: ${APP}`);
    expect(start.message).toContain(session.payloadHash);

    const authUrl = new URL(sign.authorizationUrl);
    expect(authUrl.searchParams.get('client_id')).toBe(APP);
    expect(authUrl.searchParams.get('redirect_uri')).toBe(start.callbackUri);
    expect(authUrl.searchParams.get('scope')).toBe('identify');
    expect(authUrl.searchParams.get('state')).toBe(session.oauthState);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('code_challenge'))
      .toBe(createHash('sha256').update(session.pkceVerifier).digest('base64url'));

    const record = await f.service.complete(GUILD, start.proofId, f.callbackUrl(start.proofId));
    expect(record).toMatchObject({
      guildId: GUILD, applicationId: APP, wallet: account.address,
      discordUserId: OWNER, payloadHash: session.payloadHash, proofId: start.proofId,
    });
    expect(JSON.stringify(record)).not.toContain(ACCESS_TOKEN);
    expect(f.store.getAuthorityRecord(GUILD, APP)).toEqual(record);
    expect(f.service.currentRecord(GUILD, APP, session.payloadHash)).toEqual(record);
    expect(f.service.currentRecord(GUILD, APP, 'cc'.repeat(32))).toBeNull();

    // The exchange carried the PKCE verifier and never a client secret.
    const exchange = f.calls.find((c) => c.url.endsWith('/oauth2/token'));
    const form = new URLSearchParams(exchange?.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('test-authorization-code');
    expect(form.get('code_verifier')).toBe(session.pkceVerifier);
    expect(form.get('client_secret')).toBeNull();
    // The session row is consumed and its secrets are scrubbed.
    const consumed = f.store.getAuthoritySession(start.proofId);
    expect(consumed?.consumedAt).not.toBeNull();
    expect(consumed?.pkceVerifier).toBe('');
    expect(consumed?.oauthState).toBe('');
  });

  it('rejects a signature from the wrong wallet and does not mark the session signed', async () => {
    const f = fixture();
    const start = await f.service.start(GUILD, CHANNEL, ATTESTATION_URL);
    const session = f.store.getAuthoritySession(start.proofId) as AuthoritySession;
    const bad = await otherAccount.signMessage({ message: canonicalAuthorityMessage(session) });
    await expect(f.service.sign(GUILD, start.proofId, bad)).rejects.toThrow(/does not match/);
    expect(f.store.getAuthoritySession(start.proofId)?.signedAt).toBeNull();
  });

  it('refuses to complete before signing, and refuses a second completion (replay)', async () => {
    const f = fixture();
    const start = await f.service.start(GUILD, CHANNEL, ATTESTATION_URL);
    expect(await f.service.complete(GUILD, start.proofId, f.callbackUrl(start.proofId))).toBeNull();
    const session = f.store.getAuthoritySession(start.proofId) as AuthoritySession;
    const signature = await account.signMessage({ message: canonicalAuthorityMessage(session) });
    await f.service.sign(GUILD, start.proofId, signature);
    await expect(f.service.sign(GUILD, start.proofId, signature)).rejects.toThrow(/already signed/);
    expect(await f.service.complete(GUILD, start.proofId, f.callbackUrl(start.proofId))).not.toBeNull();
    expect(await f.service.complete(GUILD, start.proofId, f.callbackUrl(start.proofId))).toBeNull();
    expect(f.calls.filter((c) => c.url.endsWith('/oauth2/token'))).toHaveLength(1);
  });

  it('rejects a wrong OAuth state without burning the ceremony', async () => {
    const f = fixture();
    const { start } = await f.startAndSign();
    expect(await f.service.complete(GUILD, start.proofId,
      f.callbackUrl(start.proofId, { state: 'forged-state' }))).toBeNull();
    expect(f.store.getAuthoritySession(start.proofId)?.consumedAt).toBeNull();
    expect(await f.service.complete(GUILD, start.proofId, f.callbackUrl(start.proofId))).not.toBeNull();
  });

  it('rejects a wrong issuer and an expired ceremony', async () => {
    const f = fixture();
    const { start } = await f.startAndSign();
    expect(await f.service.complete(GUILD, start.proofId,
      f.callbackUrl(start.proofId, { iss: 'https://evil.example' }))).toBeNull();
    f.setNow('2026-10-26T20:11:00.000Z');
    expect(await f.service.complete(GUILD, start.proofId, f.callbackUrl(start.proofId))).toBeNull();
    expect(f.store.getAuthorityRecord(GUILD, APP)).toBeNull();
  });

  it('fails closed when the token belongs to another application', async () => {
    const f = fixture();
    const { start } = await f.startAndSign();
    f.setMeBody({ application: { id: '999999999999999999' }, user: { id: OWNER }, scopes: ['identify'] });
    expect(await f.service.complete(GUILD, start.proofId, f.callbackUrl(start.proofId))).toBeNull();
    expect(f.store.getAuthorityRecord(GUILD, APP)).toBeNull();
    // The failed exchange burned the ceremony: a retry cannot replay the code.
    expect(f.store.getAuthoritySession(start.proofId)?.consumedAt).not.toBeNull();
    expect(await f.service.complete(GUILD, start.proofId, f.callbackUrl(start.proofId))).toBeNull();
    expect(f.calls.filter((c) => c.url.endsWith('/oauth2/token'))).toHaveLength(1);
  });

  it('requires the identify scope and a real authorizing user', async () => {
    const f = fixture();
    const a = await f.startAndSign();
    f.setMeBody({ application: { id: APP }, user: { id: OWNER }, scopes: [] });
    expect(await f.service.complete(GUILD, a.start.proofId, f.callbackUrl(a.start.proofId))).toBeNull();

    const g = fixture();
    const b = await g.startAndSign();
    g.setMeBody({ application: { id: APP }, user: { id: 'not-a-snowflake' }, scopes: ['identify'] });
    expect(await g.service.complete(GUILD, b.start.proofId, g.callbackUrl(b.start.proofId))).toBeNull();
  });

  it('aborts without consuming when the attestation changed mid-ceremony', async () => {
    const f = fixture();
    const { start } = await f.startAndSign();
    f.setAttestation(makeAttestation({
      subject: { type: 'discord_application', id: APP },
      agentWalletAddress: otherAccount.address,
      attestationUrl: ATTESTATION_URL,
      extra: { discord_bot_user_id: BOT, human_id_hash: hashHumanId(SYNTHETIC_HUMAN_ID) },
    }));
    expect(await f.service.complete(GUILD, start.proofId, f.callbackUrl(start.proofId))).toBeNull();
    expect(f.calls).toHaveLength(0);
    expect(f.store.getAuthoritySession(start.proofId)?.consumedAt).toBeNull();
  });

  it('binds the ceremony to its guild', async () => {
    const f = fixture();
    const { start } = await f.startAndSign();
    expect(await f.service.complete('999999999999999999', start.proofId, f.callbackUrl(start.proofId))).toBeNull();
  });
});

describe('callback URL parsing and origin validation', () => {
  it('accepts only the exact origin, path, and parameter set', () => {
    const proofId = 'A'.repeat(43);
    const good = `${ORIGIN}/app-authority/callback/${proofId}?code=x&state=y&iss=${encodeURIComponent('https://discord.com')}`;
    expect(parseAuthorityCallback(good, ORIGIN)).toEqual({ proofId, code: 'x', state: 'y' });
    expect(() => parseAuthorityCallback(good.replace(ORIGIN, 'https://evil.example'), ORIGIN)).toThrow();
    expect(() => parseAuthorityCallback(`${good}&extra=1`, ORIGIN)).toThrow();
    expect(() => parseAuthorityCallback(good.replace('&state=y', '&state=y&state=z'), ORIGIN)).toThrow();
    expect(() => parseAuthorityCallback(good.replace('https://', 'http://'), ORIGIN)).toThrow();
  });

  it('requires one exact HTTPS origin for configuration', () => {
    expect(requireCallbackOrigin('https://fiador.org')).toBe('https://fiador.org');
    expect(requireCallbackOrigin('https://fiador.org/')).toBe('https://fiador.org');
    expect(() => requireCallbackOrigin('http://fiador.org')).toThrow();
    expect(() => requireCallbackOrigin('https://fiador.org/callback')).toThrow();
    const base = { DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: '1' };
    expect(loadConfig(base).authorityCallbackOrigin).toBeNull();
    expect(loadConfig({ ...base, AUTHORITY_CALLBACK_ORIGIN: 'https://fiador.org' }).authorityCallbackOrigin)
      .toBe('https://fiador.org');
    expect(() => loadConfig({ ...base, AUTHORITY_CALLBACK_ORIGIN: 'https://fiador.org/x' })).toThrow();
  });
});

describe('authority store semantics', () => {
  const session = (overrides: Partial<AuthoritySession> = {}): AuthoritySession => ({
    proofId: 'p'.repeat(43), guildId: GUILD, channelId: CHANNEL, applicationId: APP,
    wallet: account.address, payloadHash: 'bb'.repeat(32), attestationUrl: ATTESTATION_URL,
    callbackUri: `${ORIGIN}/app-authority/callback/${'p'.repeat(43)}`,
    nonce: 'n', oauthState: 's', pkceVerifier: 'v',
    issuedAt: '2026-10-26T20:00:00.000Z', expiresAt: '2026-10-26T20:10:00.000Z',
    signedAt: null, consumedAt: null, ...overrides,
  });

  it('enforces sign-then-consume exactly once and scrubs secrets at consume (SQLite)', () => {
    const store = new SqliteStore(':memory:');
    store.saveAuthoritySession(session());
    expect(store.consumeAuthoritySession('p'.repeat(43), '2026-10-26T20:01:00.000Z')).toBe(false);
    expect(store.markAuthoritySessionSigned('p'.repeat(43), '2026-10-26T20:01:00.000Z')).toBe(true);
    expect(store.markAuthoritySessionSigned('p'.repeat(43), '2026-10-26T20:02:00.000Z')).toBe(false);
    expect(store.consumeAuthoritySession('p'.repeat(43), '2026-10-26T20:03:00.000Z')).toBe(true);
    expect(store.consumeAuthoritySession('p'.repeat(43), '2026-10-26T20:04:00.000Z')).toBe(false);
    const row = store.getAuthoritySession('p'.repeat(43));
    expect(row?.pkceVerifier).toBe('');
    expect(row?.oauthState).toBe('');
    store.saveAuthorityRecord({
      guildId: GUILD, applicationId: APP, wallet: account.address, discordUserId: OWNER,
      payloadHash: 'bb'.repeat(32), attestationUrl: ATTESTATION_URL,
      provenAt: '2026-10-26T20:03:00.000Z', proofId: 'p'.repeat(43),
    });
    expect(store.pruneAuthoritySessions('2026-10-27T20:00:00.000Z')).toBe(1);
    expect(store.getAuthoritySession('p'.repeat(43))).toBeNull();
    // Records survive session pruning.
    expect(store.getAuthorityRecord(GUILD, APP)?.discordUserId).toBe(OWNER);
    store.close();
  });

  it('allows exactly one consumer across two SQLite connections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fiador-authority-'));
    const path = join(dir, 'state.db');
    try {
      const a = new SqliteStore(path);
      a.saveAuthoritySession(session());
      a.markAuthoritySessionSigned('p'.repeat(43), '2026-10-26T20:01:00.000Z');
      const b = new SqliteStore(path);
      expect(a.consumeAuthoritySession('p'.repeat(43), '2026-10-26T20:02:00.000Z')).toBe(true);
      expect(b.consumeAuthoritySession('p'.repeat(43), '2026-10-26T20:02:30.000Z')).toBe(false);
      a.close(); b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('authority commands', () => {
  function deps(f: ReturnType<typeof fixture>, withAuthority = true): CommandDeps {
    return {
      service: f.verify, store: f.store, adapter: f.adapter,
      sync: new RoleSyncEngine({ store: f.store, service: f.verify, adapter: f.adapter }),
      rateLimiter: new AttemptRateLimiter(),
      defaultSyncIntervalMinutes: 360,
      appAuthority: withAuthority ? f.service : undefined,
    };
  }

  it('registers the three authority subcommands', () => {
    const fiador = buildCommandDefinitions().find((c) => c.name === 'fiador');
    const names = (fiador?.options ?? []).map((o) => (o as { name: string }).name);
    expect(names).toContain('authority-start');
    expect(names).toContain('authority-sign');
    expect(names).toContain('authority-complete');
  });

  it('gates on Manage Guild and on the ceremony being configured', async () => {
    const f = fixture();
    const denied = await handleFiadorAuthorityStart(
      makeCtx({ url: ATTESTATION_URL }, { hasManageGuild: false }), deps(f));
    expect(denied.content).toMatch(/requires Manage Guild/);
    const unavailable = await handleFiadorAuthorityStart(makeCtx({ url: ATTESTATION_URL }), deps(f, false));
    expect(unavailable.content).toMatch(/unavailable on this verifier/);
  });

  it('runs the full ceremony through the command handlers', async () => {
    const f = fixture();
    const d = deps(f);
    const started = await handleFiadorAuthorityStart(
      makeCtx({ url: ATTESTATION_URL }, { guildId: GUILD, channelId: CHANNEL }), d);
    const proofId = /Ceremony ID: `([^`]+)`/.exec(started.content ?? '')?.[1] as string;
    expect(proofId).toBeTruthy();
    expect(started.content).toContain(`${ORIGIN}/app-authority/callback/${proofId}`);
    const session = f.store.getAuthoritySession(proofId) as AuthoritySession;
    const signature = await account.signMessage({ message: canonicalAuthorityMessage(session) });
    const signed = await handleFiadorAuthoritySign(
      makeCtx({ proof_id: proofId, signature }, { guildId: GUILD, channelId: CHANNEL }), d);
    expect(signed.content).toContain('discord.com/api/oauth2/authorize');
    const completed = await handleFiadorAuthorityComplete(
      makeCtx({ proof_id: proofId, callback_url: f.callbackUrl(proofId) }, { guildId: GUILD, channelId: CHANNEL }), d);
    expect(completed.content).toMatch(/Application authority recorded/);
    expect(completed.content).toContain(OWNER);
  });

  it('status reports a current authority record and stays unproven without one', async () => {
    const f = fixture();
    const attestation = makeAttestation({
      subject: { type: 'discord_application', id: APP },
      agentWalletAddress: account.address, attestationUrl: ATTESTATION_URL,
      extra: { discord_bot_user_id: BOT, human_id_hash: hashHumanId(SYNTHETIC_HUMAN_ID) },
    });
    f.store.upsertBinding({
      guildId: GUILD, applicationId: APP, attestationUrl: ATTESTATION_URL,
      payloadHash: payloadHash(attestation), boundVia: 'url', boundBy: 'u1',
      boundAt: '2026-10-26T00:00:00.000Z', botUserId: BOT,
    });
    const d = deps(f);
    const before = await handleFiadorStatus(makeCtx({}, { guildId: GUILD }), d);
    expect(before.content).toContain('application control unproven');
    f.store.saveAuthorityRecord({
      guildId: GUILD, applicationId: APP, wallet: account.address, discordUserId: OWNER,
      payloadHash: payloadHash(attestation), attestationUrl: ATTESTATION_URL,
      provenAt: '2026-10-26T20:05:00.000Z', proofId: 'p'.repeat(43),
    });
    const after = await handleFiadorStatus(makeCtx({}, { guildId: GUILD }), d);
    expect(after.content).toContain('application authority proven 2026-10-26T20:05:00.000Z');
  });
});
