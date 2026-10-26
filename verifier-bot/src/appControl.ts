// A deliberately limited two-party witness. It records that the attestation
// wallet signed a fresh challenge and the named bot posted its nonce. A bot may echo
// arbitrary users, so this is NOT application-operator control proof.
import { randomBytes } from 'node:crypto';
import { createPublicClient, http, type Hex } from 'viem';
import { worldchain } from 'viem/chains';
import type { DiscordAdapter } from './discordAdapter.js';
import { discordProfileFailure, isDiscordSnowflake } from './profile.js';
import type { ControlChallenge, Store } from './store.js';
import { payloadHash, type VerifyService } from './verifyService.js';

const NONCE = /^[0-9a-f]{64}$/;
const SIGNATURE = /^0x(?:[0-9a-fA-F]{2}){1,1024}$/;
const TEN_MINUTES = 10 * 60 * 1000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Private UTF-8 message signed by the wallet. Never ask the target bot to post it. */
export function canonicalChallengeText(challenge: ControlChallenge): string {
  return `Fiador private wallet-signature witness v2\n${JSON.stringify({
    domain: 'fiador.org',
    version: 2,
    guildId: challenge.guildId,
    channelId: challenge.channelId,
    verifierBotUserId: challenge.verifierBotUserId,
    applicationId: challenge.applicationId,
    botUserId: challenge.botUserId,
    wallet: challenge.wallet,
    payloadHash: challenge.payloadHash,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  })}`;
}

/** Public text posted by the target bot. The random nonce links it to the private signed row. */
export function canonicalBotResponseText(challenge: ControlChallenge): string {
  return `<@${challenge.verifierBotUserId}>\nFiador public bot-response witness v2\nnonce:${challenge.nonce}`;
}

/** Discord caps the list at 50. Exactly 50 is ambiguous, so fail closed. */
export function matchesDiscordIntegration(value: unknown, applicationId: string, botUserId: string): boolean {
  if (!Array.isArray(value) || value.length >= 50) return false;
  const forApp = value.filter((item: unknown) => {
    const integration = record(item);
    return record(integration?.application)?.id === applicationId;
  });
  if (forApp.length !== 1) return false;
  const integration = record(forApp[0]);
  const application = record(integration?.application);
  const bot = record(application?.bot);
  return integration?.type === 'discord' && integration.enabled === true &&
    integration.revoked !== true && application?.id === applicationId &&
    bot?.id === botUserId;
}

export function matchesDiscordMessage(value: unknown, challenge: ControlChallenge, messageId: string): boolean {
  const message = record(value);
  const author = record(message?.author);
  if (!message || !author) return false;
  const timestamp = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : NaN;
  return Number.isFinite(timestamp) &&
    timestamp >= Date.parse(challenge.issuedAt) && timestamp < Date.parse(challenge.expiresAt) &&
    message.id === messageId && message.channel_id === challenge.channelId &&
    (message.guild_id === undefined || message.guild_id === challenge.guildId) &&
    message.type === 0 && (message.flags === undefined || message.flags === 0) &&
    message.content === canonicalBotResponseText(challenge) &&
    message.edited_timestamp === null &&
    (message.webhook_id === undefined || message.webhook_id === null) &&
    message.message_reference === undefined && message.message_snapshots === undefined &&
    message.interaction === undefined && message.interaction_metadata === undefined &&
    message.application_id === undefined &&
    author.id === challenge.botUserId && author.bot === true;
}

export type WalletSignatureVerifier = (wallet: `0x${string}`, message: string, signature: Hex) => Promise<boolean>;

/** The RPC chain is checked before contract-wallet verification. */
export function createWalletSignatureVerifier(rpcUrl?: string | null): WalletSignatureVerifier {
  const client = createPublicClient({ chain: worldchain, transport: http(rpcUrl ?? undefined) });
  return async (wallet, message, signature) => {
    if (await client.getChainId() !== worldchain.id) return false;
    return client.verifyMessage({ address: wallet, message, signature });
  };
}

export interface AppControlDeps {
  service: VerifyService;
  store: Store;
  adapter: DiscordAdapter;
  verifyWalletSignature: WalletSignatureVerifier;
  now?: () => Date;
  nonce?: () => string;
}

export class AppControlService {
  private readonly now: () => Date;
  private readonly nonce: () => string;
  constructor(private readonly deps: AppControlDeps) {
    this.now = deps.now ?? (() => new Date());
    this.nonce = deps.nonce ?? (() => randomBytes(32).toString('hex'));
  }

  async start(guildId: string, channelId: string, attestationUrl: string): Promise<ControlChallenge> {
    if (!isDiscordSnowflake(guildId) || !isDiscordSnowflake(channelId)) throw new Error('Invalid guild or channel ID.');
    const verifierBotUserId = this.deps.adapter.verifierBotUserId();
    if (!isDiscordSnowflake(verifierBotUserId) ||
        await this.deps.adapter.getChannelGuildId(channelId) !== guildId) {
      throw new Error('The challenge channel is not a verifier-owned guild channel.');
    }
    const attestation = await this.deps.service.fetchAttestation(attestationUrl);
    const applicationId = attestation.payload.subject.id;
    const outcome = await this.deps.service.checkAttestation(guildId, attestation);
    if (outcome.result.status !== 'verified') throw new Error('The attestation did not verify.');
    const profileFailure = discordProfileFailure(attestation, applicationId, attestationUrl, outcome.result.humanHash);
    if (profileFailure) throw new Error(profileFailure);
    const canonicalPayloadHash = payloadHash(attestation);
    if (!await this.deps.service.isPublishedClaimCurrent(guildId, applicationId, attestationUrl, canonicalPayloadHash)) {
      throw new Error('The attestation differs from the current published Discord claim or is revoked.');
    }
    const botUserId = attestation.payload.extra?.discord_bot_user_id;
    if (!isDiscordSnowflake(botUserId)) throw new Error('Invalid signed bot user ID.');
    if (!matchesDiscordIntegration(await this.deps.adapter.getGuildIntegrations(guildId), applicationId, botUserId)) {
      throw new Error('No unique, enabled Discord integration matches the signed app and bot.');
    }
    const issuedAt = this.now();
    const nonce = this.nonce();
    if (!NONCE.test(nonce)) throw new Error('Invalid challenge nonce source.');
    const challenge: ControlChallenge = {
      nonce, guildId, channelId, verifierBotUserId, applicationId, botUserId,
      wallet: attestation.payload.agentWalletAddress,
      payloadHash: canonicalPayloadHash, attestationUrl,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + TEN_MINUTES).toISOString(),
      consumedAt: null, messageId: null,
    };
    this.deps.store.saveControlChallenge(challenge);
    return challenge;
  }

  async complete(guildId: string, nonce: string, signature: string, messageId: string): Promise<boolean> {
    if (!NONCE.test(nonce) || !SIGNATURE.test(signature) || !isDiscordSnowflake(messageId)) return false;
    const challenge = this.deps.store.getControlChallenge(nonce);
    if (!challenge || challenge.guildId !== guildId || challenge.consumedAt ||
        this.now().toISOString() >= challenge.expiresAt) return false;
    const text = canonicalChallengeText(challenge);
    let signatureValid: boolean;
    try {
      signatureValid = await this.deps.verifyWalletSignature(challenge.wallet, text, signature as Hex);
    } catch {
      return false;
    }
    if (!signatureValid) return false;
    const attestation = await this.deps.service.fetchAttestation(challenge.attestationUrl);
    const outcome = await this.deps.service.checkAttestation(guildId, attestation);
    if (outcome.result.status !== 'verified' ||
        attestation.payload.subject.id !== challenge.applicationId ||
        attestation.payload.agentWalletAddress !== challenge.wallet ||
        attestation.payload.extra?.discord_bot_user_id !== challenge.botUserId ||
        payloadHash(attestation) !== challenge.payloadHash ||
        discordProfileFailure(attestation, challenge.applicationId, challenge.attestationUrl, outcome.result.humanHash)) {
      return false;
    }
    if (!await this.deps.service.isPublishedClaimCurrent(
      guildId, challenge.applicationId, challenge.attestationUrl, challenge.payloadHash,
    )) return false;
    if (await this.deps.adapter.getChannelGuildId(challenge.channelId) !== guildId) return false;
    if (!matchesDiscordIntegration(
      await this.deps.adapter.getGuildIntegrations(guildId), challenge.applicationId, challenge.botUserId,
    )) return false;
    const message = await this.deps.adapter.getChannelMessage(challenge.channelId, messageId);
    if (!matchesDiscordMessage(message, challenge, messageId)) return false;
    // Re-check the integration immediately before the atomic one-use update.
    if (!matchesDiscordIntegration(
      await this.deps.adapter.getGuildIntegrations(guildId), challenge.applicationId, challenge.botUserId,
    )) return false;
    return this.deps.store.consumeControlChallenge(nonce, this.now().toISOString(), messageId);
  }
}
