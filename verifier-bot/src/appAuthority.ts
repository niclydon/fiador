// Application-authority ceremony (docs/app-authority.md).
//
// The bot-response witness (appControl.ts) proves a wallet signed a fresh
// challenge and the named bot answered. It does not prove the signer holds
// authority over the Discord application: a bot token proves only token
// possession. This ceremony proves the missing half.
//
// Primitive: Discord OAuth2 run through the target application itself, with
// a PKCE (S256) exchange and no client secret anywhere. The verifier mints a
// one-use session whose callback URI is unique to the session. That exact
// URI must be registered in the target application's OAuth settings before
// Discord will redirect to it, and redirect URIs are NOT writable with a bot
// token (verified live against the Fiador application on Oct 31, 2026: a
// bot-token PATCH was accepted and silently ignored). Registering the URI
// therefore requires Developer Portal access, which only the application's
// owner or team has. The attestation wallet signs the session statement,
// a Discord account authorizes the application with the `identify` scope,
// and the verifier exchanges the returned code itself and reads
// GET /oauth2/@me: the token's application must be the challenged
// application. The access token is used once and never stored or logged.
//
// The honest claim this supports is application authority (team-grade):
// the wallet holder and an account with authority over the application
// took part in one fresh ceremony. It is not sole legal ownership, and no
// public copy may say it is. A completed ceremony writes an authority
// record keyed to the attestation's payload hash; re-issuing the
// attestation requires a fresh ceremony. Role automation stays disabled:
// records are evidence for a later policy decision, not a role grant.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getAddress, type Hex } from 'viem';
import type { DiscordAdapter } from './discordAdapter.js';
import { matchesDiscordIntegration, type WalletSignatureVerifier } from './appControl.js';
import { discordProfileFailure, isDiscordSnowflake } from './profile.js';
import type { AuthorityRecord, AuthoritySession, Store } from './store.js';
import { payloadHash, type VerifyService } from './verifyService.js';

export const AUTHORITY_CALLBACK_PATH = '/app-authority/callback/';
const AUTHORIZE_ENDPOINT = 'https://discord.com/api/oauth2/authorize';
const EXCHANGE_ENDPOINT = 'https://discord.com/api/oauth2/token';
const AUTHORIZATION_ENDPOINT = 'https://discord.com/api/v10/oauth2/@me';
const DISCORD_ISSUER = 'https://discord.com';
const TEN_MINUTES = 10 * 60 * 1000;
const PROOF_ID = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^0x(?:[0-9a-fA-F]{2}){1,1024}$/;

function fail(reason: string): never {
  throw new Error(reason);
}

/** The callback origin must be one exact HTTPS origin, nothing more. */
export function requireCallbackOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.origin !== value.replace(/\/$/, '')
  ) {
    fail('callback origin must be an exact HTTPS origin');
  }
  return url.origin;
}

function randomToken(entropy: (size: number) => Buffer): string {
  const bytes = entropy(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
    fail('entropy source must return 32 bytes');
  }
  return bytes.toString('base64url');
}

function matchesSecret(received: string | null, expected: string): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The exact statement the attestation wallet signs. Private; never posted. */
export function canonicalAuthorityMessage(session: AuthoritySession): string {
  return [
    'Fiador application authority ceremony v1',
    `Wallet: ${session.wallet}`,
    `Discord application ID: ${session.applicationId}`,
    `Callback URI: ${session.callbackUri}`,
    `Attestation payload hash: ${session.payloadHash}`,
    `Nonce: ${session.nonce}`,
    `Expires at: ${session.expiresAt}`,
    'This signature takes part in an application-authority ceremony. It does not by itself grant a Discord role or publish a claim.',
  ].join('\n');
}

export interface ParsedAuthorityCallback {
  proofId: string;
  code: string;
  state: string;
}

/** Strictly parse the callback URL the operator pastes back. */
export function parseAuthorityCallback(callbackUrl: string, origin: string): ParsedAuthorityCallback {
  const url = new URL(callbackUrl);
  if (url.origin !== origin || url.protocol !== 'https:' || url.hash || url.username || url.password) {
    fail('callback URI mismatch');
  }
  if (!url.pathname.startsWith(AUTHORITY_CALLBACK_PATH)) fail('callback URI mismatch');
  const proofId = url.pathname.slice(AUTHORITY_CALLBACK_PATH.length);
  if (!PROOF_ID.test(proofId)) fail('callback URI mismatch');
  for (const name of url.searchParams.keys()) {
    if (!['code', 'state', 'iss'].includes(name) || url.searchParams.getAll(name).length !== 1) {
      fail('unexpected or repeated callback parameter');
    }
  }
  if ([...url.searchParams.keys()].length !== 3) fail('callback parameters incomplete');
  if (url.searchParams.get('iss') !== DISCORD_ISSUER) fail('OAuth issuer mismatch');
  const code = url.searchParams.get('code');
  if (!code || code.length > 2048) fail('authorization code missing or oversized');
  return { proofId, code, state: url.searchParams.get('state') as string };
}

export type DiscordOAuthTransport = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    redirect: 'error';
  },
) => Promise<{
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** Production transport: the real fetch, with a hard timeout. */
export function createDiscordOAuthTransport(timeoutMs = 10_000): DiscordOAuthTransport {
  return async (url, init) => globalThis.fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function responseJson(
  response: Awaited<ReturnType<DiscordOAuthTransport>>,
): Promise<Record<string, unknown>> {
  if (!response?.ok || !response.headers?.get('content-type')?.toLowerCase().startsWith('application/json')) {
    fail('Discord response was not successful JSON');
  }
  const body = await response.text();
  if (body.length > 16_384) fail('Discord response too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    fail('Discord response was invalid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('Discord response was not an object');
  }
  return parsed as Record<string, unknown>;
}

export interface AppAuthorityDeps {
  service: VerifyService;
  store: Store;
  adapter: DiscordAdapter;
  verifyWalletSignature: WalletSignatureVerifier;
  /** Exact HTTPS origin serving the callback helper page. */
  callbackOrigin: string;
  fetchDiscord: DiscordOAuthTransport;
  now?: () => Date;
  entropy?: (size: number) => Buffer;
}

export interface AuthorityStart {
  proofId: string;
  message: string;
  callbackUri: string;
  expiresAt: string;
}

export interface AuthoritySign {
  authorizationUrl: string;
  callbackUri: string;
}

export class AppAuthorityService {
  private readonly now: () => Date;
  private readonly entropy: (size: number) => Buffer;
  private readonly origin: string;

  constructor(private readonly deps: AppAuthorityDeps) {
    this.now = deps.now ?? (() => new Date());
    this.entropy = deps.entropy ?? randomBytes;
    this.origin = requireCallbackOrigin(deps.callbackOrigin);
  }

  async start(guildId: string, channelId: string, attestationUrl: string): Promise<AuthorityStart> {
    if (!isDiscordSnowflake(guildId) || !isDiscordSnowflake(channelId)) {
      throw new Error('Invalid guild or channel ID.');
    }
    const verifierBotUserId = this.deps.adapter.verifierBotUserId();
    if (!isDiscordSnowflake(verifierBotUserId) ||
        await this.deps.adapter.getChannelGuildId(channelId) !== guildId) {
      throw new Error('The ceremony channel is not a verifier-owned guild channel.');
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
    const proofId = randomToken(this.entropy);
    const callbackUri = `${this.origin}${AUTHORITY_CALLBACK_PATH}${proofId}`;
    const session: AuthoritySession = {
      proofId,
      guildId,
      channelId,
      applicationId,
      wallet: getAddress(attestation.payload.agentWalletAddress),
      payloadHash: canonicalPayloadHash,
      attestationUrl,
      callbackUri,
      nonce: randomToken(this.entropy),
      oauthState: randomToken(this.entropy),
      pkceVerifier: randomToken(this.entropy),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + TEN_MINUTES).toISOString(),
      signedAt: null,
      consumedAt: null,
    };
    this.deps.store.saveAuthoritySession(session);
    return {
      proofId,
      message: canonicalAuthorityMessage(session),
      callbackUri,
      expiresAt: session.expiresAt,
    };
  }

  async sign(guildId: string, proofId: string, signature: string): Promise<AuthoritySign> {
    if (!PROOF_ID.test(proofId) || !SIGNATURE.test(signature)) {
      throw new Error('Invalid ceremony ID or signature.');
    }
    const session = this.deps.store.getAuthoritySession(proofId);
    if (!session || session.guildId !== guildId || session.consumedAt || session.signedAt ||
        this.now().toISOString() >= session.expiresAt) {
      throw new Error('The ceremony is unavailable, already signed, or expired.');
    }
    let signatureValid: boolean;
    try {
      signatureValid = await this.deps.verifyWalletSignature(
        session.wallet, canonicalAuthorityMessage(session), signature as Hex,
      );
    } catch {
      throw new Error('The wallet signature could not be checked.');
    }
    if (!signatureValid) throw new Error('The wallet signature does not match the attestation wallet.');
    if (!this.deps.store.markAuthoritySessionSigned(proofId, this.now().toISOString())) {
      throw new Error('The ceremony is unavailable, already signed, or expired.');
    }
    const challenge = createHash('sha256').update(session.pkceVerifier).digest('base64url');
    const url = new URL(AUTHORIZE_ENDPOINT);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', session.applicationId);
    url.searchParams.set('redirect_uri', session.callbackUri);
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', session.oauthState);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('prompt', 'consent');
    return { authorizationUrl: url.toString(), callbackUri: session.callbackUri };
  }

  /**
   * Complete the ceremony from the pasted callback URL. Returns the saved
   * authority record, or null when any evidence check fails. The session is
   * consumed atomically before the code exchange, so a failed exchange
   * still burns the ceremony (fail closed, as in the experiment): a fresh
   * ceremony is cheap, a replayed code must be worthless.
   */
  async complete(guildId: string, proofId: string, callbackUrl: string): Promise<AuthorityRecord | null> {
    if (!PROOF_ID.test(proofId)) return null;
    let parsed: ParsedAuthorityCallback;
    try {
      parsed = parseAuthorityCallback(callbackUrl, this.origin);
    } catch {
      return null;
    }
    if (parsed.proofId !== proofId) return null;
    const session = this.deps.store.getAuthoritySession(proofId);
    if (!session || session.guildId !== guildId || session.consumedAt || !session.signedAt ||
        this.now().toISOString() >= session.expiresAt) {
      return null;
    }
    if (`${this.origin}${AUTHORITY_CALLBACK_PATH}${proofId}` !== session.callbackUri) return null;
    if (!matchesSecret(parsed.state, session.oauthState)) return null;

    // Re-verify the attestation before consuming: the claim being proven
    // must still be the published, verified claim the ceremony started on.
    try {
      const attestation = await this.deps.service.fetchAttestation(session.attestationUrl);
      const outcome = await this.deps.service.checkAttestation(guildId, attestation);
      if (outcome.result.status !== 'verified' ||
          attestation.payload.subject.id !== session.applicationId ||
          getAddress(attestation.payload.agentWalletAddress) !== session.wallet ||
          payloadHash(attestation) !== session.payloadHash ||
          discordProfileFailure(attestation, session.applicationId, session.attestationUrl, outcome.result.humanHash)) {
        return null;
      }
      if (!await this.deps.service.isPublishedClaimCurrent(
        guildId, session.applicationId, session.attestationUrl, session.payloadHash,
      )) return null;
    } catch {
      return null;
    }

    if (!this.deps.store.consumeAuthoritySession(proofId, this.now().toISOString())) return null;

    let record: AuthorityRecord;
    try {
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code: parsed.code,
        redirect_uri: session.callbackUri,
        client_id: session.applicationId,
        code_verifier: session.pkceVerifier,
      });
      const exchange = await responseJson(await this.deps.fetchDiscord(EXCHANGE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        redirect: 'error',
      }));
      if (exchange.token_type !== 'Bearer' || typeof exchange.access_token !== 'string' || !exchange.access_token) {
        return null;
      }
      // The access token is used for exactly this one read. It is never
      // returned, stored, or logged. Any refresh token is ignored: this
      // ceremony is not account linking.
      const authorization = await responseJson(await this.deps.fetchDiscord(AUTHORIZATION_ENDPOINT, {
        method: 'GET',
        headers: { authorization: `Bearer ${exchange.access_token}` },
        redirect: 'error',
      }));
      const application = authorization.application as Record<string, unknown> | undefined;
      const user = authorization.user as Record<string, unknown> | undefined;
      if (application?.id !== session.applicationId) return null;
      if (!Array.isArray(authorization.scopes) || !authorization.scopes.includes('identify')) return null;
      if (!isDiscordSnowflake(user?.id)) return null;
      if (this.now().toISOString() >= session.expiresAt) return null;
      record = {
        guildId,
        applicationId: session.applicationId,
        wallet: session.wallet,
        discordUserId: user.id as string,
        payloadHash: session.payloadHash,
        attestationUrl: session.attestationUrl,
        provenAt: this.now().toISOString(),
        proofId,
      };
    } catch {
      return null;
    }
    this.deps.store.saveAuthorityRecord(record);
    return record;
  }

  /** A record is current only for the exact attestation it was proven against. */
  currentRecord(guildId: string, applicationId: string, currentPayloadHash: string | null): AuthorityRecord | null {
    if (!currentPayloadHash) return null;
    const record = this.deps.store.getAuthorityRecord(guildId, applicationId);
    return record && record.payloadHash === currentPayloadHash ? record : null;
  }
}
