import { getAddress, isAddress } from 'viem';
import type {
  AttestationPayloadV1,
  EvmAddress,
  FailureCode,
  SignedAttestation,
} from './types.js';

// Sort comparator for `extra` keys: lexicographic by Unicode code
// point, equivalently UTF-8 byte order (SPEC 3.2, pinned Oct 26, 2026
// on the 7.5 review's m3). JavaScript's default string sort compares
// UTF-16 code units, which orders astral-plane keys before BMP keys
// above U+D7FF; comparing the UTF-8 encodings does not.
const utf8Encoder = new TextEncoder();
export function compareExtraKeys(a: string, b: string): number {
  const ab = utf8Encoder.encode(a);
  const bb = utf8Encoder.encode(b);
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ab[i] !== bb[i]) return (ab[i] as number) - (bb[i] as number);
  }
  return ab.length - bb.length;
}

// The canonical signing form is part of the protocol and versioned with
// the payload (SPEC 3.2): JSON with keys in the exact order of the
// payload definition, `extra` keys sorted as above, no insignificant
// whitespace, addresses checksummed, timestamps in UTC ISO 8601 with
// `Z`. This deterministic string — and nothing else — is the message
// that is signed.
//
// The string is assembled field by field from the sorted entries,
// never by handing an object to a JSON serialiser: a serialiser
// re-orders integer-like keys numerically ("1","2","10" instead of
// "1","10","2") and an object built by assignment silently drops a
// `__proto__` key through the prototype setter — either way the bytes
// signed would not be the bytes the payload carries (7.5 review
// M7/M8/m3). Per-value JSON.stringify is used only for individual
// strings and the version number, where key order cannot arise.
export function canonicalAttestationMessage(payload: AttestationPayloadV1): string {
  const parts: string[] = [];
  parts.push(`"version":${JSON.stringify(payload.version)}`);
  parts.push(
    `"subject":{"type":${JSON.stringify(payload.subject.type)},"id":${JSON.stringify(payload.subject.id)}}`,
  );
  parts.push(`"agentWalletAddress":${JSON.stringify(getAddress(payload.agentWalletAddress))}`);
  if (payload.attestationUrl !== undefined)
    parts.push(`"attestationUrl":${JSON.stringify(payload.attestationUrl)}`);
  if (payload.operatorDisplayName !== undefined)
    parts.push(`"operatorDisplayName":${JSON.stringify(payload.operatorDisplayName)}`);
  parts.push(`"humanIdDisclosure":${JSON.stringify(payload.humanIdDisclosure)}`);
  parts.push(`"issuedAt":${JSON.stringify(payload.issuedAt)}`);
  parts.push(`"expiresAt":${JSON.stringify(payload.expiresAt)}`);
  parts.push(`"nonce":${JSON.stringify(payload.nonce)}`);
  if (payload.extra !== undefined) {
    const entries = Object.entries(payload.extra).sort(([a], [b]) =>
      compareExtraKeys(a, b),
    );
    const inner = entries
      .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
      .join(',');
    parts.push(`"extra":{${inner}}`);
  }
  return `{${parts.join(',')}}`;
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

const ISO_Z =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const HEX_NONCE = /^[0-9a-fA-F]{32,}$/;
const B64URL_NONCE = /^[A-Za-z0-9_-]{22,}$/;

// Length caps on attacker-controlled strings (7.5 review m4): generous
// for every legitimate use, small enough that a hostile document cannot
// make the verifier (or its logs and stores) carry unbounded fields.
export const MAX_NONCE_LENGTH = 128;
export const MAX_SUBJECT_TYPE_LENGTH = 64;
export const MAX_SUBJECT_ID_LENGTH = 256;

// Strict calendar validation (7.5 review M9): Date.parse rolls
// impossible dates over (2026-02-30 parses as March 2), so the
// components are round-tripped through Date.UTC and must come back
// unchanged.
export function isValidIsoZTimestamp(value: string): boolean {
  const m = ISO_Z.exec(value);
  if (!m) return false;
  const [, y, mo, d, h, mi, s, frac] = m as unknown as [
    string, string, string, string, string, string, string,
    string | undefined,
  ];
  const ms = frac === undefined ? 0 : Number(frac.padEnd(3, '0'));
  const t = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms),
  );
  return (
    t.getUTCFullYear() === Number(y) &&
    t.getUTCMonth() === Number(mo) - 1 &&
    t.getUTCDate() === Number(d) &&
    t.getUTCHours() === Number(h) &&
    t.getUTCMinutes() === Number(mi) &&
    t.getUTCSeconds() === Number(s) &&
    t.getUTCMilliseconds() === ms
  );
}

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
    // The subject object is closed (7.5 review B3): exactly {type, id}.
    // A smuggled third field (for example a raw humanId) is malformed,
    // never silently carried into a signed-payload reconstruction.
    Object.keys(subject).some((k) => k !== 'type' && k !== 'id') ||
    typeof subject.type !== 'string' ||
    subject.type.length === 0 ||
    subject.type.length > MAX_SUBJECT_TYPE_LENGTH ||
    typeof subject.id !== 'string' ||
    subject.id.length === 0 ||
    subject.id.length > MAX_SUBJECT_ID_LENGTH
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
    !isValidIsoZTimestamp(value.issuedAt) ||
    typeof value.expiresAt !== 'string' ||
    !isValidIsoZTimestamp(value.expiresAt)
  ) {
    return { ok: false, failures: ['malformed_attestation'] };
  }
  if (
    typeof value.nonce !== 'string' ||
    value.nonce.length > MAX_NONCE_LENGTH ||
    !(HEX_NONCE.test(value.nonce) || B64URL_NONCE.test(value.nonce))
  ) {
    return { ok: false, failures: ['malformed_attestation'] };
  }

  let extra: Record<string, string> | undefined;
  if (value.extra !== undefined) {
    if (!isPlainObject(value.extra)) return { ok: false, failures: ['malformed_attestation'] };
    // Null-prototype container (7.5 review M7): assigning a `__proto__`
    // key onto a normal object invokes the prototype setter and the
    // signed field silently vanishes; here every key is stored as data.
    extra = Object.create(null) as Record<string, string>;
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
const ENVELOPE_KEYS = new Set(['payload', 'signature', 'signatureType']);

export function validateSignedAttestation(value: unknown): AttestationValidation {
  if (!isPlainObject(value)) return { ok: false, failures: ['malformed_attestation'] };
  // The envelope is closed (7.5 review B3): exactly {payload,
  // signature, signatureType}. Any further key (for example a raw
  // humanId riding alongside the payload) makes the document
  // malformed, whatever its signature says.
  for (const key of Object.keys(value)) {
    if (!ENVELOPE_KEYS.has(key)) return { ok: false, failures: ['malformed_attestation'] };
  }
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
  if (value.signatureType !== 'eip191' && value.signatureType !== 'eip1271') {
    return {
      ok: false,
      failures: ['malformed_attestation'],
      wallet: payloadCheck.payload.agentWalletAddress,
    };
  }
  // The signature shape gate follows the DECLARED type (7.5 review
  // B1): an EIP-191 signature is exactly 65 bytes; an ERC-1271
  // signature is an opaque blob whose length is the contract's own
  // business (Safe and passkey validators routinely exceed 65 bytes),
  // so it is gated only as non-empty even-length hex.
  const signature = value.signature;
  const signatureOk =
    typeof signature === 'string' &&
    (value.signatureType === 'eip191'
      ? /^0x[0-9a-fA-F]{130}$/.test(signature)
      : /^0x(?:[0-9a-fA-F]{2})+$/.test(signature));
  if (!signatureOk) {
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
      signature: signature as string,
      signatureType: value.signatureType,
    },
  };
}
