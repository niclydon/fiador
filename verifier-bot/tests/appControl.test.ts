import { beforeEach, describe, expect, it } from 'vitest';
import { verifyMessage } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { AppControlService, canonicalBotResponseText, canonicalChallengeText, matchesDiscordIntegration, matchesDiscordMessage } from '../src/appControl.js';
import { InMemoryStore } from '../src/store.js';
import { FakeDiscordAdapter } from './helpers.js';
import { createVerifier, hashHumanId, makeAttestation, resetFakeVerifier, SYNTHETIC_HUMAN_ID } from './fakeVerify.js';
import { VerifyService, type VerifierLike } from '../src/verifyService.js';
import { AttemptRateLimiter, buildCommandDefinitions, handleFiadorControlComplete, handleFiadorControlStart, type CommandDeps } from '../src/commands.js';
import { makeCtx } from './helpers.js';

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const APP = '333333333333333333';
const BOT = '444444444444444444';
const VERIFIER = '555555555555555555';
const MESSAGE = '666666666666666666';
const URL = 'https://operator.example.com/attestation.json';
const account = privateKeyToAccount(generatePrivateKey());

function fixture() {
  let now = new Date('2026-10-26T20:00:00.000Z');
  let attestation = makeAttestation({
    subject: { type: 'discord_application', id: APP },
    agentWalletAddress: account.address,
    attestationUrl: URL,
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
    fetchJson: async () => attestation,
  });
  const service = new AppControlService({
    service: verify, store, adapter,
    now: () => now,
    nonce: () => 'aa'.repeat(32),
    verifyWalletSignature: async (wallet, text, signature) => verifyMessage({ address: wallet, message: text, signature }),
  });
  return {
    store, adapter, verify, service,
    setNow(value: string) { now = new Date(value); },
    setAttestation(value: typeof attestation) { attestation = value; },
  };
}

beforeEach(() => resetFakeVerifier('verified'));

describe('Discord app response witness', () => {
  it('requires one unique enabled Discord integration with the claimed app and bot', () => {
    const good = { type: 'discord', enabled: true, application: { id: APP, bot: { id: BOT } } };
    expect(matchesDiscordIntegration([good], APP, BOT)).toBe(true);
    expect(matchesDiscordIntegration([{ ...good, application: { id: APP } }], APP, BOT)).toBe(false);
    expect(matchesDiscordIntegration([good, good], APP, BOT)).toBe(false);
    expect(matchesDiscordIntegration([...Array(50).fill({ type: 'youtube' })], APP, BOT)).toBe(false);
    expect(matchesDiscordIntegration([{ ...good, type: 'youtube' }], APP, BOT)).toBe(false);
    expect(matchesDiscordIntegration([{ ...good, enabled: false }], APP, BOT)).toBe(false);
    expect(matchesDiscordIntegration([{ ...good, application: { id: APP, bot: { id: '999999999999999999' } } }], APP, BOT)).toBe(false);
  });

  it('requires the exact fresh, unedited, non-webhook bot message', () => {
    const challenge = { nonce: 'aa'.repeat(32), guildId: GUILD, channelId: CHANNEL,
      verifierBotUserId: VERIFIER, applicationId: APP, botUserId: BOT,
      wallet: '0x1234567890AbcdEF1234567890aBcdef12345678' as const,
      payloadHash: 'bb'.repeat(32), attestationUrl: 'https://example.com/a.json',
      issuedAt: '2026-10-26T20:00:00.000Z', expiresAt: '2026-10-26T20:10:00.000Z',
      consumedAt: null, messageId: null };
    const text = canonicalBotResponseText(challenge);
    const message = { id: MESSAGE, channel_id: CHANNEL, author: { id: BOT, bot: true },
      type: 0, content: text, timestamp: '2026-10-26T20:01:00.000Z', edited_timestamp: null };
    expect(matchesDiscordMessage(message, challenge, message.id)).toBe(true);
    expect(matchesDiscordMessage({ ...message, webhook_id: '777777777777777777' }, challenge, message.id)).toBe(false);
    expect(matchesDiscordMessage({ ...message, edited_timestamp: message.timestamp }, challenge, message.id)).toBe(false);
    expect(matchesDiscordMessage({ ...message, timestamp: '2026-10-26T19:59:00.000Z' }, challenge, message.id)).toBe(false);
    expect(matchesDiscordMessage({ ...message, author: { id: BOT, bot: false } }, challenge, message.id)).toBe(false);
    expect(matchesDiscordMessage({ ...message, author: { id: BOT } }, challenge, message.id)).toBe(false);
    expect(matchesDiscordMessage({ ...message, guild_id: '999999999999999999' }, challenge, message.id)).toBe(false);
    expect(matchesDiscordMessage(message, challenge, '888888888888888888')).toBe(false);
    expect(matchesDiscordMessage({ ...message, content: ` ${text}` }, challenge, message.id)).toBe(false);
    expect(matchesDiscordMessage({ ...message, content: canonicalChallengeText(challenge) }, challenge, message.id)).toBe(false);
    expect(matchesDiscordMessage({ ...message, channel_id: GUILD }, challenge, message.id)).toBe(false);
    expect(matchesDiscordMessage({ ...message, type: 1 }, challenge, message.id)).toBe(false);
    expect(matchesDiscordMessage({ ...message, flags: 2 }, challenge, message.id)).toBe(false);
    expect(matchesDiscordMessage({ ...message, interaction_metadata: {} }, challenge, message.id)).toBe(false);
    expect(matchesDiscordMessage({ ...message, message_reference: {} }, challenge, message.id)).toBe(false);
  });

  it('keeps the signed wallet and claim identifiers out of the public bot response', async () => {
    const f = fixture();
    const challenge = await f.service.start(GUILD, CHANNEL, URL);
    const privateText = canonicalChallengeText(challenge);
    const publicText = canonicalBotResponseText(challenge);
    expect(privateText).toContain(challenge.wallet);
    expect(privateText).toContain(challenge.payloadHash);
    expect(privateText).toContain(challenge.applicationId);
    expect(privateText).toContain(challenge.botUserId);
    expect(privateText).toContain(challenge.guildId);
    expect(privateText).toContain(challenge.channelId);
    expect(publicText).toContain(`<@${VERIFIER}>`);
    expect(publicText).toContain(challenge.nonce);
    for (const privateValue of [challenge.wallet, challenge.payloadHash, challenge.attestationUrl,
      challenge.applicationId, challenge.botUserId, challenge.guildId, challenge.channelId]) {
      expect(publicText).not.toContain(privateValue);
    }
    expect(publicText).not.toBe(privateText);
  });

  it('records one wallet-signed and Discord-authenticated witness without binding or roles', async () => {
    const f = fixture();
    const challenge = await f.service.start(GUILD, CHANNEL, URL);
    expect(challenge.wallet).toBe(account.address);
    expect(canonicalBotResponseText(challenge)).toContain(`<@${VERIFIER}>`);
    f.adapter.message = { id: MESSAGE, channel_id: CHANNEL, author: { id: BOT, bot: true },
      type: 0, content: canonicalBotResponseText(challenge), timestamp: '2026-10-26T20:01:00.000Z', edited_timestamp: null };
    const publicTextSignature = await account.signMessage({ message: canonicalBotResponseText(challenge) });
    const signature = await account.signMessage({ message: canonicalChallengeText(challenge) });
    f.setNow('2026-10-26T20:02:00.000Z');
    expect(await f.service.complete(GUILD, challenge.nonce, publicTextSignature, MESSAGE)).toBe(false);
    expect(await f.service.complete(GUILD, challenge.nonce, signature, MESSAGE)).toBe(true);
    expect(await f.service.complete(GUILD, challenge.nonce, signature, MESSAGE)).toBe(false);
    expect(f.store.getControlChallenge(challenge.nonce)).toMatchObject({ messageId: MESSAGE, consumedAt: '2026-10-26T20:02:00.000Z' });
    expect(f.store.getBinding(GUILD, APP)).toBeNull();
  });

  it('refuses to issue a challenge for a profile that the public preview would reject', async () => {
    const f = fixture();
    f.setAttestation(makeAttestation({
      subject: { type: 'discord_application', id: APP }, agentWalletAddress: account.address,
      attestationUrl: URL, extra: { discord_bot_user_id: BOT },
    }));
    await expect(f.service.start(GUILD, CHANNEL, URL)).rejects.toThrow('human hash');
    expect(f.store.getControlChallenge('aa'.repeat(32))).toBeNull();
  });

  it('rejects wrong signature, replay, expiry, changed attestation, and Discord outage without burning the nonce', async () => {
    const f = fixture();
    const challenge = await f.service.start(GUILD, CHANNEL, URL);
    f.adapter.message = { id: MESSAGE, channel_id: CHANNEL, author: { id: BOT, bot: true },
      type: 0, content: canonicalBotResponseText(challenge), timestamp: '2026-10-26T20:01:00.000Z', edited_timestamp: null };
    const signature = await account.signMessage({ message: canonicalChallengeText(challenge) });
    f.setNow('2026-10-26T20:02:00.000Z');
    const otherAccount = privateKeyToAccount(generatePrivateKey());
    const wrongWalletSignature = await otherAccount.signMessage({ message: canonicalChallengeText(challenge) });
    expect(await f.service.complete(GUILD, challenge.nonce, wrongWalletSignature, MESSAGE)).toBe(false);
    expect(await f.service.complete(GUILD, challenge.nonce, `0x${'00'.repeat(65)}`, MESSAGE)).toBe(false);
    expect(f.store.getControlChallenge(challenge.nonce)?.consumedAt).toBeNull();
    f.setAttestation(makeAttestation({
      subject: { type: 'discord_application', id: APP }, agentWalletAddress: account.address,
      attestationUrl: URL, operatorDisplayName: 'changed',
      extra: { discord_bot_user_id: BOT, human_id_hash: hashHumanId(SYNTHETIC_HUMAN_ID) },
    }));
    expect(await f.service.complete(GUILD, challenge.nonce, signature, MESSAGE)).toBe(false);
    expect(f.store.getControlChallenge(challenge.nonce)?.consumedAt).toBeNull();
    f.setNow('2026-10-26T20:11:00.000Z');
    expect(await f.service.complete(GUILD, challenge.nonce, signature, MESSAGE)).toBe(false);
  });

  it('consumes at most once under two concurrent completions', async () => {
    const f = fixture();
    const challenge = await f.service.start(GUILD, CHANNEL, URL);
    f.adapter.message = { id: MESSAGE, channel_id: CHANNEL, author: { id: BOT, bot: true },
      type: 0, content: canonicalBotResponseText(challenge), timestamp: '2026-10-26T20:01:00.000Z', edited_timestamp: null };
    const signature = await account.signMessage({ message: canonicalChallengeText(challenge) });
    f.setNow('2026-10-26T20:02:00.000Z');
    expect((await Promise.all([
      f.service.complete(GUILD, challenge.nonce, signature, MESSAGE),
      f.service.complete(GUILD, challenge.nonce, signature, MESSAGE),
    ])).sort()).toEqual([false, true]);
  });

  it('leaves the nonce live on Discord outage or changed integration, then permits a valid retry', async () => {
    const f = fixture();
    const challenge = await f.service.start(GUILD, CHANNEL, URL);
    f.adapter.message = { id: MESSAGE, channel_id: CHANNEL, author: { id: BOT, bot: true },
      type: 0, content: canonicalBotResponseText(challenge), timestamp: '2026-10-26T20:01:00.000Z', edited_timestamp: null };
    const signature = await account.signMessage({ message: canonicalChallengeText(challenge) });
    f.setNow('2026-10-26T20:02:00.000Z');
    const originalRead = f.adapter.getGuildIntegrations.bind(f.adapter);
    f.adapter.getGuildIntegrations = async () => { throw new Error('Discord unavailable'); };
    await expect(f.service.complete(GUILD, challenge.nonce, signature, MESSAGE)).rejects.toThrow('Discord unavailable');
    expect(f.store.getControlChallenge(challenge.nonce)?.consumedAt).toBeNull();
    let calls = 0;
    f.adapter.getGuildIntegrations = async () => ++calls === 2 ? [] : originalRead();
    expect(await f.service.complete(GUILD, challenge.nonce, signature, MESSAGE)).toBe(false);
    expect(calls).toBe(2);
    expect(f.store.getControlChallenge(challenge.nonce)?.consumedAt).toBeNull();
    f.adapter.getGuildIntegrations = originalRead;
    expect(await f.service.complete(GUILD, challenge.nonce, signature, MESSAGE)).toBe(true);
  });

  it('rejects revoked registry claims even when a legacy binding points at them', async () => {
    const f = fixture();
    f.store.upsertBinding({ guildId: GUILD, applicationId: APP, attestationUrl: URL,
      payloadHash: null, boundVia: 'url', boundBy: 'old-user',
      boundAt: '2026-10-25T00:00:00.000Z', botUserId: BOT });
    f.store.upsertGuildConfig({ guildId: GUILD, roleId: null,
      registryUrl: 'https://registry.example.com/registry.json',
      syncIntervalMinutes: 360, logChannelId: null });
    const revoked = new VerifyService({
      verifier: createVerifier() as unknown as VerifierLike,
      store: f.store,
      fetchJson: async () => ({ entries: [{ discord_application_id: APP, attestation_url: URL, status: 'revoked' }] }),
    });
    expect(await revoked.resolveAttestation(GUILD, APP)).toBeNull();
    expect(await revoked.isPublishedClaimCurrent(GUILD, APP, URL, 'bb'.repeat(32))).toBe(false);
    const duplicate = new VerifyService({
      verifier: createVerifier() as unknown as VerifierLike, store: f.store,
      fetchJson: async () => ({ entries: [
        { discord_application_id: APP, attestation_url: URL },
        { discord_application_id: APP, attestation_url: URL, status: 'revoked' },
      ] }),
    });
    await expect(duplicate.resolveAttestation(GUILD, APP)).rejects.toThrow('Duplicate');
    const current = new VerifyService({
      verifier: createVerifier() as unknown as VerifierLike, store: f.store,
      fetchJson: async () => ({ entries: [{ discord_application_id: APP,
        attestation_url: URL, payload_hash: 'bb'.repeat(32) }] }),
    });
    expect(await current.isPublishedClaimCurrent(GUILD, APP, URL, 'bb'.repeat(32))).toBe(true);
    expect(await current.isPublishedClaimCurrent(GUILD, APP, URL, 'cc'.repeat(32))).toBe(false);
    expect(await current.isPublishedClaimCurrent(GUILD, APP, 'https://other.example.com/a.json', 'bb'.repeat(32))).toBe(false);
  });

  it('does not treat a legacy binding as app-control proof', async () => {
    const f = fixture();
    f.store.upsertBinding({ guildId: GUILD, applicationId: APP, attestationUrl: URL,
      payloadHash: null, boundVia: 'url', boundBy: 'old-user',
      boundAt: '2026-10-25T00:00:00.000Z', botUserId: BOT });
    const challenge = await f.service.start(GUILD, CHANNEL, URL);
    expect(challenge).toBeDefined();
    expect(f.store.getBinding(GUILD, APP)?.boundVia).toBe('url');
  });

  it('exposes private start/complete commands with Manage Guild gating and no role authority', async () => {
    const f = fixture();
    const deps = { appControl: f.service, rateLimiter: new AttemptRateLimiter() } as CommandDeps;
    const blocked = await handleFiadorControlStart(
      makeCtx({ url: URL }, { guildId: GUILD, channelId: CHANNEL, hasManageGuild: false }), deps);
    expect(blocked.content).toContain('requires Manage Guild');
    expect(f.store.getControlChallenge('aa'.repeat(32))).toBeNull();
    const started = await handleFiadorControlStart(
      makeCtx({ url: URL }, { guildId: GUILD, channelId: CHANNEL }), deps);
    expect(started.ephemeral).toBe(true);
    expect(started.content).toContain('does not establish application-operator control');
    const challenge = f.store.getControlChallenge('aa'.repeat(32))!;
    expect(started.content).toContain(canonicalChallengeText(challenge));
    expect(started.content).toContain(canonicalBotResponseText(challenge));
    expect(started.content).toContain('Do not post it');
    expect(started.content).toContain('post only the separate public text');
    expect(started.content?.split('Public bot-response text:')[1]).not.toContain(challenge.wallet);
    expect(started.content?.length).toBeLessThanOrEqual(2000);
    const signature = await account.signMessage({ message: canonicalChallengeText(challenge) });
    f.adapter.message = { id: MESSAGE, channel_id: CHANNEL, author: { id: BOT, bot: true },
      type: 0, content: canonicalBotResponseText(challenge), timestamp: '2026-10-26T20:01:00.000Z', edited_timestamp: null };
    f.setNow('2026-10-26T20:02:00.000Z');
    const completed = await handleFiadorControlComplete(makeCtx({ nonce: challenge.nonce,
      signature, message_id: MESSAGE }, { guildId: GUILD, channelId: CHANNEL }), deps);
    expect(completed.content).toContain('Application-operator control remains unproven');
    expect(f.store.getBinding(GUILD, APP)).toBeNull();
    const [fiador] = buildCommandDefinitions();
    expect(JSON.stringify(fiador)).toContain('control-start');
    expect(JSON.stringify(fiador)).toContain('control-complete');
  });
});
