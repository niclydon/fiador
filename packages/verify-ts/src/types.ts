// Verify core types — W0 spec (~/workspace/world-program/w0-verify-core/SPEC.md) §3.0–3.2.
// This package is the W0 verify core's home in the Fiador repo. Public outputs
// carry the humanId HASH only; the full humanId never crosses toPublicVerifyResult.

import { createHash } from 'node:crypto';

export type EvmAddress = `0x${string}`;

export type VerificationStatus =
  | 'verified'
  | 'unregistered'
  | 'expired'
  | 'invalid'
  | 'unknown';

export type FailureCode =
  | 'malformed_address'
  | 'malformed_attestation'
  | 'unsupported_version'
  | 'signature_mismatch'
  | 'subject_mismatch'
  | 'wallet_mismatch'
  | 'not_yet_valid'
  | 'expired'
  | 'not_registered'
  | 'replay_detected'
  | 'attestation_not_found'
  | 'lookup_failed'
  | 'lookup_timeout';

export interface CheckEvidence {
  checkedAt: string;
  source: 'live' | 'cache' | 'fixture';
  agentBook: { network: 'eip155:480'; contract: EvmAddress };
  rpcLatencyMs?: number;
}

export interface VerifyResult {
  status: VerificationStatus;
  address: EvmAddress;
  addressTruncated: string;
  humanHash: string | null;
  /** INTERNAL ONLY. Present only when built with includeRawHumanId. Never serialised publicly. */
  humanId?: string | null;
  /** INTERNAL ONLY. The attestation's disclosure choice, when the result came from one. */
  disclosure?: 'hash' | 'none';
  failures: FailureCode[];
  evidence: CheckEvidence;
}

export interface PublicVerifyResult {
  status: VerificationStatus;
  addressTruncated: string;
  humanHash: string | null;
  failures: FailureCode[];
  evidence: CheckEvidence;
}

export interface AttestationPayloadV1 {
  version: 1;
  subject: { type: string; id: string };
  agentWalletAddress: EvmAddress;
  attestationUrl?: string;
  operatorDisplayName?: string;
  humanIdDisclosure: 'hash' | 'none';
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  extra?: Record<string, string>;
}

export interface SignedAttestation {
  payload: AttestationPayloadV1;
  signature: string;
  signatureType: 'eip191' | 'eip1271';
}

export const AGENTBOOK_CONTRACT: EvmAddress =
  '0xA23aB2712eA7BBa896930544C7d6636a96b944dA';
export const WORLD_CHAIN_NETWORK = 'eip155:480' as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddress(value: unknown): value is EvmAddress {
  return typeof value === 'string' && ADDRESS_RE.test(value);
}

/** Display truncation: 0x + 4 … last 5. Never a full address on public surfaces. */
export function truncateAddress(address: string): string {
  if (!isEvmAddress(address)) return '0x…';
  return `${address.slice(0, 6)}…${address.slice(-5)}`;
}

/**
 * The one sanctioned public hash of a humanId (W0 spec §3.5 / W1 DESIGN §3.3):
 * sha256 over utf8("w0-human-v1:" + humanId), digest as lowercase hex, no 0x.
 */
export function hashHumanId(humanId: string): string {
  return createHash('sha256')
    .update(`w0-human-v1:${humanId.toLowerCase()}`, 'utf8')
    .digest('hex');
}

/**
 * Canonical signing form (W0 spec §3.2): JSON with keys in the protocol order
 * shown there, `extra` keys sorted, no insignificant whitespace.
 */
export function canonicalAttestationBytes(payload: AttestationPayloadV1): string {
  const ordered: Record<string, unknown> = {};
  ordered.version = payload.version;
  ordered.subject = { type: payload.subject.type, id: payload.subject.id };
  ordered.agentWalletAddress = payload.agentWalletAddress;
  if (payload.attestationUrl !== undefined) ordered.attestationUrl = payload.attestationUrl;
  if (payload.operatorDisplayName !== undefined)
    ordered.operatorDisplayName = payload.operatorDisplayName;
  ordered.humanIdDisclosure = payload.humanIdDisclosure;
  ordered.issuedAt = payload.issuedAt;
  ordered.expiresAt = payload.expiresAt;
  ordered.nonce = payload.nonce;
  if (payload.extra !== undefined) {
    const extra: Record<string, string> = {};
    for (const key of Object.keys(payload.extra).sort()) extra[key] = payload.extra[key];
    ordered.extra = extra;
  }
  return JSON.stringify(ordered);
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Short-id for /v/ links (DESIGN §6.4): first 10 chars of base32(sha256(canonical bytes)). */
export function attestationShortId(attestation: SignedAttestation, length = 10): string {
  const digest = createHash('sha256')
    .update(canonicalAttestationBytes(attestation.payload), 'utf8')
    .digest();
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= length) break;
  }
  return out.slice(0, length);
}

/** The only sanctioned crossing from internal to public shape (W0 spec §3.0). */
export function toPublicVerifyResult(result: VerifyResult): PublicVerifyResult {
  return {
    status: result.status,
    addressTruncated: result.addressTruncated,
    humanHash: result.disclosure === 'none' ? null : result.humanHash,
    failures: [...result.failures],
    evidence: { ...result.evidence, agentBook: { ...result.evidence.agentBook } },
  };
}
