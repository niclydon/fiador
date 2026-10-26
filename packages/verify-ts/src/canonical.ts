import { getAddress, isAddress } from 'viem';
import type {
  AttestationPayloadV1,
  EvmAddress,
  FailureCode,
  SignedAttestation,
} from './types.js';

// The canonical signing form is part of the protocol and versioned with
// the payload (SPEC 3.2): JSON with keys in the exact order of the
// payload definition, `extra` keys sorted lexicographically, no
// insignificant whitespace, addresses checksummed, timestamps in UTC
// ISO 8601 with `Z`. This deterministic string — and nothing else — is
// the message that is signed.
export function canonicalAttestationMessage(payload: AttestationPayloadV1): string {
  const ordered: Record<string, unknown> = {};
  ordered.version = payload.version;
  ordered.subject = { type: payload.subject.type, id: payload.subject.id };
  ordered.agentWalletAddress = getAddress(payload.agentWalletAddress);
  if (payload.attestationUrl !== undefined) ordered.attestationUrl = payload.attestationUrl;
  if (payload.operatorDisplayName !== undefined)
    ordered.operatorDisplayName = payload.operatorDisplayName;
  ordered.humanIdDisclosure = payload.humanIdDisclosure;
  ordered.issuedAt = payload.issuedAt;
  ordered.expiresAt = payload.expiresAt;
  ordered.nonce = payload.nonce;
  if (payload.extra !== undefined) {
    const extra: Record<string, string> = {};
    for (const key of Object.keys(payload.extra).sort()) {
      extra[key] = payload.extra[key] as string;
    }
    ordered.extra = extra;
  }
  return JSON.stringify(ordered);
}

const PAYLOAD_KEYS = new Set([
  'version',
  'subject',
  'agentWalletAddress',
  'attestationUrl',
  'operatorDisplayName',
  'humanIdDisclosure',
  'issuedAt',
  'expiresAt',
  'nonce',
  'extra',
]);

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const HEX_NONCE = /^[0-9a-fA-F]{32,}$/;
const B64URL_NONCE = /^[A-Za-z0-9_-]{22,}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type PayloadValidation =
  | { ok: true; payload: AttestationPayloadV1 }
  | { ok: false; failures: FailureCode[] };

// Envelope validation (SPEC 3.3 step 1): parses and checks the payload's
// shape, version, and field forms. Date semantics, lifetime, signature,
// binding, and registration are the verifier's later steps, not this one.
export function validatePayload(value: unknown): PayloadValidation {
  if (!isPlainObject(value)) return { ok: false, failures: ['malformed_attestation'] };
  for (const key of Object.keys(value)) {
    if (!PAYLOAD_KEYS.has(key)) return { ok: false, failures: ['malformed_attestation'] };
  }
  if (value.version !== undefined && value.version !== 1) {
    return { ok: false, failures: ['unsupported_version'] };
  }
  if (value.version !== 1) return { ok: false, failures: ['malformed_attestation'] };

  const subject = value.subject;
  if (
    !isPlainObject(subject) ||
    typeof subject.type !== 'string' ||
    subject.type.length === 0 ||
    typeof subject.id !== 'string' ||
    subject.id.length === 0
  ) {
    return { ok: false, failures: ['malformed_attestation'] };
  }

  if (typeof value.agentWalletAddress !== 'string' || !isAddress(value.agentWalletAddress)) {
    return { ok: false, failures: ['malformed_attestation'] };
  }
  let wallet: EvmAddress;
  try {
    wallet = getAddress(value.agentWalletAddress);
  } catch {
    return { ok: false, failures: ['malformed_attestation'] };
  }

  if (
    value.attestationUrl !== undefined &&
    (typeof value.attestationUrl !== 'string' || value.attestationUrl.length > 2048)
  ) {
    return { ok: false, failures: ['malformed_attestation'] };
  }
  if (
    value.operatorDisplayName !== undefined &&
    (typeof value.operatorDisplayName !== 'string' || value.operatorDisplayName.length > 128)
  ) {
    return { ok: false, failures: ['malformed_attestation'] };
  }
  if (value.humanIdDisclosure !== 'hash' && value.humanIdDisclosure !== 'none') {
    return { ok: false, failures: ['malformed_attestation'] };
  }
  if (
    typeof value.issuedAt !== 'string' ||
    !ISO_Z.test(value.issuedAt) ||
    Number.isNaN(Date.parse(value.issuedAt)) ||
    typeof value.expiresAt !== 'string' ||
    !ISO_Z.test(value.expiresAt) ||
    Number.isNaN(Date.parse(value.expiresAt))
  ) {
    return { ok: false, failures: ['malformed_attestation'] };
  }
  if (
    typeof value.nonce !== 'string' ||
    !(HEX_NONCE.test(value.nonce) || B64URL_NONCE.test(value.nonce))
  ) {
    return { ok: false, failures: ['malformed_attestation'] };
  }

  let extra: Record<string, string> | undefined;
  if (value.extra !== undefined) {
    if (!isPlainObject(value.extra)) return { ok: false, failures: ['malformed_attestation'] };
    extra = {};
    for (const [k, v] of Object.entries(value.extra)) {
      if (typeof v !== 'string') return { ok: false, failures: ['malformed_attestation'] };
      extra[k] = v;
    }
  }

  const payload: AttestationPayloadV1 = {
    version: 1,
    subject: { type: subject.type as string, id: subject.id as string },
    agentWalletAddress: wallet,
    ...(value.attestationUrl !== undefined
      ? { attestationUrl: value.attestationUrl as string }
      : {}),
    ...(value.operatorDisplayName !== undefined
      ? { operatorDisplayName: value.operatorDisplayName as string }
      : {}),
    humanIdDisclosure: value.humanIdDisclosure as 'hash' | 'none',
    issuedAt: value.issuedAt as string,
    expiresAt: value.expiresAt as string,
    nonce: value.nonce as string,
    ...(extra !== undefined ? { extra } : {}),
  };
  return { ok: true, payload };
}

export type AttestationValidation =
  | { ok: true; attestation: SignedAttestation }
  | { ok: false; failures: FailureCode[]; wallet?: EvmAddress };

// Full envelope validation of a SignedAttestation presented as unknown
// input. When the payload names a well-formed wallet, it is returned
// alongside failures so the result can still be addressed to it.
export function validateSignedAttestation(value: unknown): AttestationValidation {
  if (!isPlainObject(value)) return { ok: false, failures: ['malformed_attestation'] };
  const payloadCheck = validatePayload(value.payload);
  if (!payloadCheck.ok) {
    const partial = isPlainObject(value.payload) ? value.payload : undefined;
    let wallet: EvmAddress | undefined;
    if (typeof partial?.agentWalletAddress === 'string' && isAddress(partial.agentWalletAddress)) {
      try {
        wallet = getAddress(partial.agentWalletAddress);
      } catch {
        wallet = undefined;
      }
    }
    return { ok: false, failures: payloadCheck.failures, ...(wallet ? { wallet } : {}) };
  }
  if (
    typeof value.signature !== 'string' ||
    !/^0x[0-9a-fA-F]{130}$/.test(value.signature)
  ) {
    return {
      ok: false,
      failures: ['malformed_attestation'],
      wallet: payloadCheck.payload.agentWalletAddress,
    };
  }
  if (value.signatureType !== 'eip191' && value.signatureType !== 'eip1271') {
    return {
      ok: false,
      failures: ['malformed_attestation'],
      wallet: payloadCheck.payload.agentWalletAddress,
    };
  }
  return {
    ok: true,
    attestation: {
      payload: payloadCheck.payload,
      signature: value.signature,
      signatureType: value.signatureType,
    },
  };
}
