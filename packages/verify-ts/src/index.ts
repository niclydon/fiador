// @fiador/verify — public surface. This file is the package's contract
// (SPEC section 3): the exports below, and no others. A small surface
// is the point — every export is a promise.
export { canonicalAttestationMessage } from './canonical.js';
export { hashHumanId, truncateAddress } from './hash.js';
export { toPublicVerifyResult } from './projection.js';
export { createVerifier } from './verifier.js';
export { InMemoryNonceStore } from './nonce-store.js';
export type {
  AgentBookReader,
  AttestationPayloadV1,
  CheckEvidence,
  EvmAddress,
  FailureCode,
  NonceClaimResult,
  PublicVerifyResult,
  SignedAttestation,
  SignedMessageResult,
  SignedMessageSignatureType,
  StatusSubject,
  VerificationStatus,
  VerifyAttestationOptions,
  VerifyCoreOptions,
  VerifyResult,
  VerifySignedMessageInput,
  Verifier,
} from './types.js';

import type { VerificationStatus } from './types.js';

const STATUSES: ReadonlySet<string> = new Set([
  'verified',
  'unregistered',
  'expired',
  'invalid',
  'unknown',
]);

// Type guard for consumers parsing status values off the wire
// (for example the badge service's JSON, SPEC 4.2).
export function isVerificationStatus(value: unknown): value is VerificationStatus {
  return typeof value === 'string' && STATUSES.has(value);
}
