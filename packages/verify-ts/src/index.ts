// Verify core — W0 spec (~/workspace/world-program/w0-verify-core/SPEC.md) §3.1–3.5.
//
// STUB BOUNDARIES (this build):
// - Signature verification is an INJECTED dependency (SignatureVerifier).
//   The default, stubSignatureVerifier, verifies NOTHING. Real EIP-191
//   recovery / ERC-1271 validation via viem lands with the W0 core build;
//   this stub exists so consumers (badge service, verifier bot, MCP) can
//   build and test against the final interface today.
// - There is no default AgentBookReader in this build: the SDK-backed
//   reader from spec §3.1 is part of the W0 core build. A verifier built
//   without a reader reports every lookup as 'unknown' + 'lookup_failed'
//   rather than guessing — fail closed, never fabricate 'unregistered'.

import {
  AGENTBOOK_CONTRACT,
  canonicalAttestationBytes,
  hashHumanId,
  isEvmAddress,
  truncateAddress,
  type AttestationPayloadV1,
  type CheckEvidence,
  type EvmAddress,
  type FailureCode,
  type SignedAttestation,
  type VerificationStatus,
  type VerifyResult,
} from './types.js';

export * from './types.js';

// ---------------------------------------------------------------------------
// Injected dependencies and options (spec §3.1, §3.3)
// ---------------------------------------------------------------------------

export interface AgentBookReader {
  // Returns the raw humanId for the core's internal use, or null when the
  // contract read succeeded and there is no entry. MUST throw on
  // transport/RPC failure so the core can return 'unknown' instead of
  // misreporting 'unregistered'.
  lookupHuman(address: EvmAddress): Promise<string | null>;
}

export interface SignatureVerifier {
  // Returns true iff the signature is valid for the attestation's wallet
  // over the canonical bytes. Implementations must resolve false — never
  // throw — for a well-formed attestation whose signature does not verify.
  verifySignature(
    attestation: SignedAttestation,
    canonicalBytes: string,
  ): Promise<boolean>;
}

/**
 * STUB signature verifier: verifies nothing, returns false for every input.
 * Real EIP-191 / ERC-1271 verification (viem `verifyMessage`) replaces this
 * in the W0 core build. It exists so the rest of the pipeline — and its
 * tests — can run against the SignatureVerifier interface before the real
 * cryptography lands. A verifier built on this stub can never produce a
 * 'verified' attestation result, which is the safe failure direction.
 */
export const stubSignatureVerifier: SignatureVerifier = {
  async verifySignature(): Promise<boolean> {
    return false;
  },
};

export interface NonceStore {
  has(nonce: string, wallet: EvmAddress): Promise<boolean>;
  add(nonce: string, wallet: EvmAddress, expiresAt: string): Promise<void>;
}

export interface VerifyCoreOptions {
  reader?: AgentBookReader; // absent in this build => lookups report 'unknown'
  signatureVerifier?: SignatureVerifier; // default: stubSignatureVerifier
  rpcUrl?: string; // recorded for parity with spec §3.1; unused by the stub core
  contractAddress?: EvmAddress; // default: canonical AgentBook
  timeoutMs?: number; // per-lookup deadline, default 5000
  now?: () => Date; // injectable clock
  clockSkewMs?: number; // default 60_000
  includeRawHumanId?: boolean; // default false; see spec §3.5
  source?: CheckEvidence['source']; // evidence source tag, default 'live'
}

export interface VerifyAttestationOptions {
  expectedSubject?: { type: string; id: string };
  expectedWallet?: EvmAddress;
  nonceStore?: NonceStore;
  checkRegistration?: boolean; // default true
  signal?: AbortSignal;
}

export type StatusSubject =
  | { kind: 'address'; address: string }
  | { kind: 'attestation'; attestation: SignedAttestation }
  | {
      kind: 'attested_subject';
      subject: { type: string; id: string };
      resolveAttestation: (subject: {
        type: string;
        id: string;
      }) => Promise<SignedAttestation | null>;
    };

export interface Verifier {
  verifyAddress(
    address: string,
    opts?: { signal?: AbortSignal },
  ): Promise<VerifyResult>;
  verifyAttestation(
    attestation: unknown,
    opts?: VerifyAttestationOptions,
  ): Promise<VerifyResult>;
  resolveStatus(
    subject: StatusSubject,
    opts?: { signal?: AbortSignal },
  ): Promise<VerifyResult>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as EvmAddress;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CLOCK_SKEW_MS = 60_000;
const MAX_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const NONCE_RE = /^[A-Za-z0-9+/=_-]+$/;

class LookupTimeoutError extends Error {
  constructor() {
    super('AgentBook lookup timed out');
    this.name = 'LookupTimeoutError';
  }
}

function normaliseAddress(address: string): EvmAddress {
  return address.toLowerCase() as EvmAddress;
}

/** Races a promise against the per-lookup deadline and the caller's signal. */
function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LookupTimeoutError()), timeoutMs);
    const onAbort = () => reject(new Error('AgentBook lookup aborted'));
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error('AgentBook lookup aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

type LookupOutcome =
  | { outcome: 'registered'; humanId: string; latencyMs: number }
  | { outcome: 'unregistered'; latencyMs: number }
  | { outcome: 'failed'; code: 'lookup_failed' | 'lookup_timeout'; latencyMs: number };

interface Core {
  reader?: AgentBookReader;
  signatureVerifier: SignatureVerifier;
  contractAddress: EvmAddress;
  timeoutMs: number;
  now: () => Date;
  clockSkewMs: number;
  includeRawHumanId: boolean;
  source: CheckEvidence['source'];
}

function makeEvidence(core: Core, rpcLatencyMs?: number): CheckEvidence {
  const evidence: CheckEvidence = {
    checkedAt: core.now().toISOString(),
    source: core.source,
    agentBook: { network: 'eip155:480', contract: core.contractAddress },
  };
  if (rpcLatencyMs !== undefined) evidence.rpcLatencyMs = rpcLatencyMs;
  return evidence;
}

function baseResult(
  core: Core,
  status: VerificationStatus,
  address: EvmAddress,
  failures: FailureCode[],
  rpcLatencyMs?: number,
): VerifyResult {
  return {
    status,
    address,
    addressTruncated: truncateAddress(address),
    humanHash: null,
    failures,
    evidence: makeEvidence(core, rpcLatencyMs),
  };
}

/** The AgentBook read shared by verifyAddress and verifyAttestation step 6. */
async function lookupRegistration(
  core: Core,
  address: EvmAddress,
  signal?: AbortSignal,
): Promise<LookupOutcome> {
  const started = Date.now();
  const latency = () => Date.now() - started;
  if (!core.reader) {
    return { outcome: 'failed', code: 'lookup_failed', latencyMs: latency() };
  }
  try {
    const humanId = await withDeadline(
      core.reader.lookupHuman(address),
      core.timeoutMs,
      signal,
    );
    if (humanId === null) return { outcome: 'unregistered', latencyMs: latency() };
    return { outcome: 'registered', humanId, latencyMs: latency() };
  } catch (err) {
    return {
      outcome: 'failed',
      code: err instanceof LookupTimeoutError ? 'lookup_timeout' : 'lookup_failed',
      latencyMs: latency(),
    };
  }
}

// ---------------------------------------------------------------------------
// verifyAddress (spec §3.1)
// ---------------------------------------------------------------------------

async function verifyAddress(
  core: Core,
  address: string,
  opts?: { signal?: AbortSignal },
): Promise<VerifyResult> {
  if (!isEvmAddress(address)) {
    // Placeholder address: no wallet was identified, nothing was checked.
    return baseResult(core, 'invalid', ZERO_ADDRESS, ['malformed_address']);
  }
  const normalised = normaliseAddress(address);
  const lookup = await lookupRegistration(core, normalised, opts?.signal);
  switch (lookup.outcome) {
    case 'registered': {
      const result = baseResult(core, 'verified', normalised, [], lookup.latencyMs);
      result.humanHash = hashHumanId(lookup.humanId);
      if (core.includeRawHumanId) result.humanId = lookup.humanId;
      return result;
    }
    case 'unregistered':
      return baseResult(
        core,
        'unregistered',
        normalised,
        ['not_registered'],
        lookup.latencyMs,
      );
    case 'failed':
      // A failed lookup is 'unknown', never 'unregistered' (spec §3.1 step 3).
      return baseResult(core, 'unknown', normalised, [lookup.code], lookup.latencyMs);
  }
}

// ---------------------------------------------------------------------------
// verifyAttestation (spec §3.3)
// ---------------------------------------------------------------------------

const RAW_HUMAN_ID_KEY = /human_?id/i;

/** True if any key in the object tree looks like a raw humanId field. */
function containsRawHumanIdKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsRawHumanIdKey);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key !== 'humanIdDisclosure' && RAW_HUMAN_ID_KEY.test(key)) return true;
    if (containsRawHumanIdKey(child)) return true;
  }
  return false;
}

type ShapeCheck =
  | { ok: true; attestation: SignedAttestation }
  | { ok: false; code: 'malformed_attestation' | 'unsupported_version' };

/** Step 1 (shape). A failure here ends verification: nothing else can be
 *  evaluated safely, and a raw humanId found in the payload is never echoed. */
function checkShape(attestation: unknown): ShapeCheck {
  const malformed: ShapeCheck = { ok: false, code: 'malformed_attestation' };
  if (attestation === null || typeof attestation !== 'object') return malformed;
  if (containsRawHumanIdKey(attestation)) return malformed;

  const { payload, signature, signatureType } = attestation as {
    payload?: unknown;
    signature?: unknown;
    signatureType?: unknown;
  };
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return malformed;
  }
  if (typeof signature !== 'string' || !signature.startsWith('0x')) return malformed;
  if (signatureType !== 'eip191' && signatureType !== 'eip1271') return malformed;

  const p = payload as Record<string, unknown>;
  if (p.version === undefined) return malformed;
  if (p.version !== 1) return { ok: false, code: 'unsupported_version' };

  const subject = p.subject as { type?: unknown; id?: unknown } | null;
  if (
    subject === null ||
    typeof subject !== 'object' ||
    typeof subject.type !== 'string' ||
    subject.type.length === 0 ||
    typeof subject.id !== 'string' ||
    subject.id.length === 0
  ) {
    return malformed;
  }
  if (!isEvmAddress(p.agentWalletAddress)) return malformed;
  if (p.humanIdDisclosure !== 'hash' && p.humanIdDisclosure !== 'none') {
    // There is no 'raw': a payload asking for one is malformed (spec §3.2).
    return malformed;
  }
  if (typeof p.issuedAt !== 'string' || Number.isNaN(Date.parse(p.issuedAt))) {
    return malformed;
  }
  if (typeof p.expiresAt !== 'string' || Number.isNaN(Date.parse(p.expiresAt))) {
    return malformed;
  }
  if (
    typeof p.nonce !== 'string' ||
    p.nonce.length < 22 || // >= 128 bits, hex or base64url
    !NONCE_RE.test(p.nonce)
  ) {
    return malformed;
  }
  if (p.attestationUrl !== undefined && typeof p.attestationUrl !== 'string') {
    return malformed;
  }
  if (p.operatorDisplayName !== undefined && typeof p.operatorDisplayName !== 'string') {
    return malformed;
  }
  if (p.extra !== undefined) {
    if (p.extra === null || typeof p.extra !== 'object' || Array.isArray(p.extra)) {
      return malformed;
    }
    for (const v of Object.values(p.extra as Record<string, unknown>)) {
      if (typeof v !== 'string') return malformed;
    }
  }
  return { ok: true, attestation: attestation as SignedAttestation };
}

const INVALID_CLASS: ReadonlySet<FailureCode> = new Set([
  'malformed_attestation',
  'unsupported_version',
  'malformed_address',
  'subject_mismatch',
  'wallet_mismatch',
  'signature_mismatch',
  'not_yet_valid',
  'replay_detected',
]);

/** Status precedence (spec §3.3): invalid > expired > unknown (over
 *  unregistered/verified) > unregistered > verified. */
function statusFromFailures(failures: FailureCode[]): VerificationStatus {
  if (failures.some((f) => INVALID_CLASS.has(f))) return 'invalid';
  if (failures.includes('expired')) return 'expired';
  if (failures.includes('lookup_failed') || failures.includes('lookup_timeout')) {
    return 'unknown';
  }
  if (failures.includes('not_registered')) return 'unregistered';
  return 'verified';
}

async function verifyAttestation(
  core: Core,
  attestation: unknown,
  opts: VerifyAttestationOptions = {},
): Promise<VerifyResult> {
  // Step 1: shape.
  const shape = checkShape(attestation);
  if (!shape.ok) {
    return baseResult(core, 'invalid', ZERO_ADDRESS, [shape.code]);
  }
  const signed = shape.attestation;
  const payload: AttestationPayloadV1 = signed.payload;
  const wallet = normaliseAddress(payload.agentWalletAddress);
  const failures: FailureCode[] = [];

  // Step 2: binding.
  if (
    opts.expectedSubject &&
    (opts.expectedSubject.type !== payload.subject.type ||
      opts.expectedSubject.id !== payload.subject.id)
  ) {
    failures.push('subject_mismatch');
  }
  if (
    opts.expectedWallet &&
    normaliseAddress(opts.expectedWallet) !== wallet
  ) {
    failures.push('wallet_mismatch');
  }

  // Step 3: signature, via the injected verifier over the canonical form.
  const canonicalBytes = canonicalAttestationBytes(payload);
  let signatureOk = false;
  try {
    signatureOk = await core.signatureVerifier.verifySignature(signed, canonicalBytes);
  } catch {
    signatureOk = false; // a verifier error is a failed verification, never a throw
  }
  if (!signatureOk) failures.push('signature_mismatch');

  // Step 4: dates.
  const nowMs = core.now().getTime();
  const issuedMs = Date.parse(payload.issuedAt);
  const expiresMs = Date.parse(payload.expiresAt);
  if (expiresMs - issuedMs > MAX_LIFETIME_MS) failures.push('malformed_attestation');
  if (issuedMs > nowMs + core.clockSkewMs) failures.push('not_yet_valid');
  if (expiresMs <= nowMs) failures.push('expired');

  // Step 5: replay (only when a store is supplied; otherwise stateless by design).
  if (opts.nonceStore) {
    try {
      if (await opts.nonceStore.has(payload.nonce, wallet)) {
        failures.push('replay_detected');
      }
    } catch {
      // A store that cannot answer has not cleared the nonce: fail closed.
      failures.push('replay_detected');
    }
  }

  // Step 6: registration, through the same read as verifyAddress.
  let registeredHumanId: string | null = null;
  let latencyMs: number | undefined;
  if (opts.checkRegistration !== false) {
    const lookup = await lookupRegistration(core, wallet, opts.signal);
    latencyMs = lookup.latencyMs;
    if (lookup.outcome === 'registered') {
      registeredHumanId = lookup.humanId;
    } else if (lookup.outcome === 'unregistered') {
      failures.push('not_registered');
    } else {
      failures.push(lookup.code);
    }
  }

  const status = statusFromFailures(failures);
  const result = baseResult(core, status, wallet, failures, latencyMs);
  result.disclosure = payload.humanIdDisclosure;
  if (status === 'verified' && registeredHumanId !== null) {
    result.humanHash = hashHumanId(registeredHumanId);
    if (core.includeRawHumanId) result.humanId = registeredHumanId;
  }

  // Record the nonce only on full success (spec §3.3 step 5).
  if (status === 'verified' && opts.nonceStore) {
    try {
      await opts.nonceStore.add(payload.nonce, wallet, payload.expiresAt);
    } catch {
      // Recording is best-effort bookkeeping; the verification stands.
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// resolveStatus (spec §3.5)
// ---------------------------------------------------------------------------

async function resolveStatus(
  core: Core,
  subject: StatusSubject,
  opts?: { signal?: AbortSignal },
): Promise<VerifyResult> {
  switch (subject.kind) {
    case 'address':
      return verifyAddress(core, subject.address, opts);
    case 'attestation': {
      const payload = (subject.attestation as SignedAttestation | undefined)?.payload;
      const expectedSubject =
        payload && typeof payload.subject === 'object' && payload.subject !== null
          ? { type: payload.subject.type, id: payload.subject.id }
          : undefined;
      return verifyAttestation(core, subject.attestation, {
        expectedSubject,
        signal: opts?.signal,
      });
    }
    case 'attested_subject': {
      let attestation: SignedAttestation | null;
      try {
        attestation = await subject.resolveAttestation(subject.subject);
      } catch {
        return baseResult(core, 'unknown', ZERO_ADDRESS, ['lookup_failed']);
      }
      if (attestation === null) {
        // No attestation published: nothing was checked on-chain, so neither
        // 'unregistered' nor 'invalid' would be honest (spec §3.5).
        return baseResult(core, 'unknown', ZERO_ADDRESS, ['attestation_not_found']);
      }
      return verifyAttestation(core, attestation, {
        expectedSubject: subject.subject,
        signal: opts?.signal,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createVerifier(options: VerifyCoreOptions = {}): Verifier {
  const core: Core = {
    reader: options.reader,
    signatureVerifier: options.signatureVerifier ?? stubSignatureVerifier,
    contractAddress: options.contractAddress ?? AGENTBOOK_CONTRACT,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    now: options.now ?? (() => new Date()),
    clockSkewMs: options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS,
    includeRawHumanId: options.includeRawHumanId ?? false,
    source: options.source ?? 'live',
  };
  return {
    verifyAddress: (address, opts) => verifyAddress(core, address, opts),
    verifyAttestation: (attestation, opts) => verifyAttestation(core, attestation, opts),
    resolveStatus: (subject, opts) => resolveStatus(core, subject, opts),
  };
}
