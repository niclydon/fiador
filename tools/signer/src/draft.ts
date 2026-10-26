// Draft construction (DESIGN §3.1 Discord profile of the generic payload).
//
// The draft builder derives `extra.human_id_hash` itself, in-process, from
// the operator's own live AgentBook registration (DESIGN §3.2 point 5): it
// runs the verify core's verifyAddress on the wallet and copies the
// internal result's humanHash into the payload. The full humanId never
// appears here — with the core's default options it is hashed inside the
// core and never retained — and it is never printed, logged, or written.

import { createHash, randomBytes } from 'node:crypto';
import { getAddress, isAddress } from 'viem';
import {
  canonicalAttestationMessage,
  truncateAddress,
  type AttestationPayloadV1,
  type Verifier,
} from '@fiador/verify';

export interface DraftOptions {
  applicationId: string;
  /** Defaults to the application ID (true for bots whose user id equals it). */
  botUserId?: string;
  walletAddress: string;
  attestationUrl: string;
  /** Opt-in only (§3.1.1): absent unless the operator explicitly passes it. */
  operatorName?: string;
  /** Expiry window in days: 1..90, default 90 (the §3.1 hard cap). */
  days?: number;
  now?: Date;
  /** Test seam: deterministic nonce. Production callers omit it. */
  nonce?: string;
}

const SNOWFLAKE_RE = /^\d{5,25}$/;

function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** sha256 (hex) of the payload's canonical signing message, via the core. */
export function payloadHash(payload: AttestationPayloadV1): string {
  return createHash('sha256')
    .update(canonicalAttestationMessage(payload), 'utf8')
    .digest('hex');
}

export async function buildDraft(
  verifier: Verifier,
  opts: DraftOptions,
): Promise<AttestationPayloadV1> {
  if (!SNOWFLAKE_RE.test(opts.applicationId)) {
    throw new Error(`application id is not a Discord snowflake: ${opts.applicationId}`);
  }
  const botUserId = opts.botUserId ?? opts.applicationId;
  if (!SNOWFLAKE_RE.test(botUserId)) {
    throw new Error(`bot user id is not a Discord snowflake: ${botUserId}`);
  }
  if (!isAddress(opts.walletAddress)) {
    throw new Error(`wallet address is malformed: ${opts.walletAddress}`);
  }
  const wallet = getAddress(opts.walletAddress);
  let url: URL;
  try {
    url = new URL(opts.attestationUrl);
  } catch {
    throw new Error(`attestation URL is malformed: ${opts.attestationUrl}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`attestation URL must be HTTPS: ${opts.attestationUrl}`);
  }
  if (opts.operatorName !== undefined) {
    if (opts.operatorName.length === 0 || opts.operatorName.length > 64) {
      throw new Error('operator display name must be 1..64 characters (§3.1)');
    }
  }
  const days = opts.days ?? 90;
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error(`expiry window must be 1..90 days (§3.1 hard cap), got: ${days}`);
  }

  // The hash comes from the live registration, never from the operator's
  // keyboard (§3.2 point 5). No registration -> no hash -> no draft.
  const registration = await verifier.verifyAddress(wallet);
  if (registration.status !== 'verified' || registration.humanHash === null) {
    throw new Error(
      `wallet ${truncateAddress(wallet)} is not registered in AgentBook ` +
        `(status: ${registration.status}); refusing to draft`,
    );
  }

  const now = opts.now ?? new Date();
  const expires = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const nonce = opts.nonce ?? randomBytes(24).toString('base64url');

  const payload: AttestationPayloadV1 = {
    version: 1,
    subject: { type: 'discord_application', id: opts.applicationId },
    agentWalletAddress: wallet,
    attestationUrl: opts.attestationUrl,
    ...(opts.operatorName !== undefined
      ? { operatorDisplayName: opts.operatorName }
      : {}),
    humanIdDisclosure: 'hash',
    issuedAt: isoSeconds(now),
    expiresAt: isoSeconds(expires),
    nonce,
    extra: {
      discord_bot_user_id: botUserId,
      human_id_hash: registration.humanHash,
    },
  };
  return payload;
}
