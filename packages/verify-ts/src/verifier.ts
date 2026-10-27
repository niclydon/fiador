import {
  createPublicClient,
  getAddress,
  hashMessage,
  http,
  isAddress,
  recoverMessageAddress,
  type Hex,
} from 'viem';
import { worldchain } from 'viem/chains';
import { canonicalAttestationMessage, validateSignedAttestation } from './canonical.js';
import { hashHumanId, truncateAddress } from './hash.js';
import { AGENTBOOK_CONTRACT, assertRpcUrlAllowed, createLiveReader } from './reader.js';
import type {
  CheckEvidence,
  EvmAddress,
  FailureCode,
  SignedAttestation,
  StatusSubject,
  VerificationStatus,
  VerifyAttestationOptions,
  VerifyCoreOptions,
  VerifyResult,
  Verifier,
} from './types.js';

const ZERO_ADDRESS: EvmAddress = '0x0000000000000000000000000000000000000000';
const ERC1271_MAGIC: string = '0x1626ba7e';
const MAX_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

const ERC1271_ABI = [
  {
    inputs: [
      { internalType: 'bytes32', name: 'hash', type: 'bytes32' },
      { internalType: 'bytes', name: 'signature', type: 'bytes' },
    ],
    name: 'isValidSignature',
    outputs: [{ internalType: 'bytes4', name: '', type: 'bytes4' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

type RaceOutcome<T> =
  | { kind: 'value'; value: T }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'failed' };

// Run an async operation against the verifier's deadline and an
// optional caller AbortSignal. The operation is invoked INSIDE the
// guarded region (7.5 review M12): a collaborator that throws
// synchronously — before returning its promise — is a 'failed'
// outcome, never an exception escaping a function whose contract is
// "returns a result". A late rejection after the deadline wins is
// swallowed so it never surfaces as an unhandled rejection.
async function raceDeadline<T>(
  start: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RaceOutcome<T>> {
  let call: Promise<T>;
  try {
    call = start();
  } catch {
    return { kind: 'failed' };
  }
  call.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<'timeout' | 'aborted'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    if (signal) {
      if (signal.aborted) {
        resolve('aborted');
        return;
      }
      onAbort = () => resolve('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    const winner = await Promise.race([
      call.then(
        (value) => ({ kind: 'value' as const, value }),
        () => ({ kind: 'failed' as const }),
      ),
      deadline.then((kind) => ({ kind })),
    ]);
    return winner;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

type LookupOutcome =
  | { state: 'registered'; humanId: string; latencyMs: number }
  | { state: 'unregistered'; latencyMs: number }
  | { state: 'unknown'; code: 'lookup_failed' | 'lookup_timeout'; latencyMs: number };

type SignatureOutcome =
  | { kind: 'match' }
  | { kind: 'mismatch' }
  | { kind: 'unknown'; code: 'lookup_failed' | 'lookup_timeout' };

function readDisclosure(input: unknown): 'hash' | 'none' | undefined {
  if (typeof input === 'object' && input !== null) {
    const payload = (input as { payload?: unknown }).payload;
    if (typeof payload === 'object' && payload !== null) {
      const d = (payload as { humanIdDisclosure?: unknown }).humanIdDisclosure;
      if (d === 'hash' || d === 'none') return d;
    }
  }
  return undefined;
}

export function createVerifier(options: VerifyCoreOptions = {}): Verifier {
  const contract: EvmAddress = options.contractAddress ?? AGENTBOOK_CONTRACT;
  if (!isAddress(contract)) {
    // Programmer error, not an expected failure: the library throws here
    // and only here (SPEC 3.0). The message names no value (7.5 review
    // M14): configuration values are operator material, not diagnostics.
    throw new TypeError('createVerifier: malformed contract address');
  }
  assertRpcUrlAllowed(options.rpcUrl);
  const reader =
    options.reader ??
    createLiveReader({
      contractAddress: contract,
      ...(options.rpcUrl !== undefined ? { rpcUrl: options.rpcUrl } : {}),
    });
  const timeoutMs = options.timeoutMs ?? 5000;
  const now = options.now ?? (() => new Date());
  const clockSkewMs = options.clockSkewMs ?? 60_000;
  const includeRawHumanId = options.includeRawHumanId ?? false;

  const publicClient = createPublicClient({
    chain: worldchain,
    transport: http(options.rpcUrl),
  });

  // ERC-1271 validation for a smart-wallet signer. Both RPC calls run
  // under the same deadline/abort race as the AgentBook lookup (7.5
  // review B1): a hanging eth_call must not hold verifyAttestation open
  // past timeoutMs. Distinguish three outcomes honestly: the contract
  // answered (match/mismatch), the read itself reverted or returned a
  // non-magic value (mismatch — fail closed on the claim), or the
  // network could not answer at all (unknown).
  async function erc1271Check(
    wallet: EvmAddress,
    message: string,
    signature: string,
    signal?: AbortSignal,
  ): Promise<SignatureOutcome> {
    // The configured RPC is the trust oracle for this answer too; the
    // chain-id call is a misconfiguration guard (it catches an endpoint
    // answering for another chain), not an authentication of the RPC.
    const chain = await raceDeadline(() => publicClient.getChainId(), timeoutMs, signal);
    if (chain.kind === 'timeout') return { kind: 'unknown', code: 'lookup_timeout' };
    if (chain.kind !== 'value') return { kind: 'unknown', code: 'lookup_failed' };
    if (chain.value !== worldchain.id) return { kind: 'unknown', code: 'lookup_failed' };
    const read = await raceDeadline(
      () =>
        publicClient.readContract({
          address: wallet,
          abi: ERC1271_ABI,
          functionName: 'isValidSignature',
          args: [hashMessage(message), signature as Hex],
        }),
      timeoutMs,
      signal,
    );
    if (read.kind === 'timeout') return { kind: 'unknown', code: 'lookup_timeout' };
    if (read.kind === 'aborted') return { kind: 'unknown', code: 'lookup_failed' };
    if (read.kind === 'failed') {
      // A wallet that is not a contract, or a reverting validator, is
      // not a valid ERC-1271 signature. Fail closed on the claim (SPEC 3.0).
      return { kind: 'mismatch' };
    }
    return read.value.toLowerCase() === ERC1271_MAGIC
      ? { kind: 'match' }
      : { kind: 'mismatch' };
  }

  // The declared signatureType selects the ONE verification path (7.5
  // review B1). It was previously validated and then ignored: an
  // 'eip191' document silently fell through to ERC-1271 (an unexpected
  // RPC call), and a contract wallet's EOA-looking signature could be
  // accepted on the wrong path. 'eip191' is pure local recovery and
  // never touches the network; 'eip1271' never attempts recovery.
  async function signatureCheck(
    attestation: SignedAttestation,
    message: string,
    signal?: AbortSignal,
  ): Promise<SignatureOutcome> {
    const wallet = attestation.payload.agentWalletAddress;
    if (attestation.signatureType === 'eip1271') {
      return erc1271Check(wallet, message, attestation.signature, signal);
    }
    try {
      const recovered = await recoverMessageAddress({
        message,
        signature: attestation.signature as Hex,
      });
      return recovered === wallet ? { kind: 'match' } : { kind: 'mismatch' };
    } catch {
      return { kind: 'mismatch' };
    }
  }

  function evidence(latencyMs?: number): CheckEvidence {
    return {
      checkedAt: now().toISOString(),
      source: reader.source ?? 'live',
      agentBook: { network: 'eip155:480', contract },
      ...(latencyMs !== undefined ? { rpcLatencyMs: latencyMs } : {}),
    };
  }

  function buildResult(args: {
    status: VerificationStatus;
    address: EvmAddress;
    failures: FailureCode[];
    humanId?: string | null;
    latencyMs?: number;
    disclosure?: 'hash' | 'none';
  }): VerifyResult {
    const humanId = args.humanId ?? null;
    return {
      status: args.status,
      address: args.address,
      addressTruncated: truncateAddress(args.address),
      humanHash:
        args.status === 'verified' && humanId !== null ? hashHumanId(humanId) : null,
      ...(includeRawHumanId && humanId !== null ? { humanId } : {}),
      failures: args.failures,
      evidence: evidence(args.latencyMs),
      ...(args.disclosure !== undefined ? { disclosure: args.disclosure } : {}),
    };
  }

  async function lookup(
    address: EvmAddress,
    signal?: AbortSignal,
  ): Promise<LookupOutcome> {
    const start = Date.now();
    const latency = () => Date.now() - start;
    const outcome = await raceDeadline(() => reader.lookupHuman(address), timeoutMs, signal);
    switch (outcome.kind) {
      case 'value':
        return outcome.value === null
          ? { state: 'unregistered', latencyMs: latency() }
          : { state: 'registered', humanId: outcome.value, latencyMs: latency() };
      case 'timeout':
        return { state: 'unknown', code: 'lookup_timeout', latencyMs: latency() };
      default:
        return { state: 'unknown', code: 'lookup_failed', latencyMs: latency() };
    }
  }

  async function verifyAddress(
    addressInput: string,
    opts?: { signal?: AbortSignal },
  ): Promise<VerifyResult> {
    if (typeof addressInput !== 'string' || !isAddress(addressInput)) {
      return buildResult({
        status: 'invalid',
        address: ZERO_ADDRESS,
        failures: ['malformed_address'],
      });
    }
    let address: EvmAddress;
    try {
      address = getAddress(addressInput);
    } catch {
      return buildResult({
        status: 'invalid',
        address: ZERO_ADDRESS,
        failures: ['malformed_address'],
      });
    }
    const outcome = await lookup(address, opts?.signal);
    if (outcome.state === 'registered') {
      return buildResult({
        status: 'verified',
        address,
        failures: [],
        humanId: outcome.humanId,
        latencyMs: outcome.latencyMs,
      });
    }
    if (outcome.state === 'unregistered') {
      return buildResult({
        status: 'unregistered',
        address,
        failures: ['not_registered'],
        latencyMs: outcome.latencyMs,
      });
    }
    return buildResult({
      status: 'unknown',
      address,
      failures: [outcome.code],
      latencyMs: outcome.latencyMs,
    });
  }

  async function verifyAttestation(
    input: unknown,
    opts: VerifyAttestationOptions = {},
  ): Promise<VerifyResult> {
    const disclosure = readDisclosure(input);
    const envelope = validateSignedAttestation(input);
    if (!envelope.ok) {
      return buildResult({
        status: 'invalid',
        address: envelope.wallet ?? ZERO_ADDRESS,
        failures: envelope.failures,
        ...(disclosure !== undefined ? { disclosure } : {}),
      });
    }
    const { payload } = envelope.attestation;
    const wallet = payload.agentWalletAddress;
    const failures: FailureCode[] = [];
    const finish = (status: VerificationStatus, extra: Partial<Parameters<typeof buildResult>[0]> = {}) =>
      buildResult({
        status,
        address: wallet,
        failures,
        ...(disclosure !== undefined ? { disclosure } : {}),
        ...extra,
      });

    // Step 2, binding (SPEC 3.3). Expected-wallet comparison is on the
    // normalised (lowercased) forms (7.5 review m2): a differently-cased
    // or bad-checksum spelling of the same address is the same wallet,
    // and a non-string expectation is a mismatch, never a throw.
    if (
      opts.expectedSubject &&
      (opts.expectedSubject.type !== payload.subject.type ||
        opts.expectedSubject.id !== payload.subject.id)
    ) {
      failures.push('subject_mismatch');
    }
    if (opts.expectedWallet !== undefined) {
      const expected: unknown = opts.expectedWallet;
      const matches =
        typeof expected === 'string' &&
        /^0x[0-9a-fA-F]{40}$/.test(expected) &&
        expected.toLowerCase() === wallet.toLowerCase();
      if (!matches) failures.push('wallet_mismatch');
    }

    // Step 3, signature over the canonical form, on the declared path.
    const message = canonicalAttestationMessage(payload);
    const signature = await signatureCheck(envelope.attestation, message, opts.signal);

    // Step 4 facts (dates and the protocol lifetime cap) are computed
    // before any early return: they are established from the payload
    // alone, and per SPEC 3.3 precedence they outrank 'unknown' — a
    // network failure at the signature step must not pre-empt an
    // expiry or discard a binding failure (7.5 review B1).
    const nowMs = now().getTime();
    const issuedMs = Date.parse(payload.issuedAt);
    const expiresMs = Date.parse(payload.expiresAt);
    const lifetimeInvalid = expiresMs <= issuedMs || expiresMs - issuedMs > MAX_LIFETIME_MS;
    const notYetValid = issuedMs > nowMs + clockSkewMs;
    const expired = expiresMs <= nowMs;
    const dateFailures = (): FailureCode[] => {
      const out: FailureCode[] = [];
      if (lifetimeInvalid) out.push('attestation_lifetime_invalid');
      if (notYetValid) out.push('not_yet_valid');
      if (expired) out.push('expired');
      return out;
    };

    if (signature.kind === 'unknown') {
      failures.push(...dateFailures());
      const invalidClass = failures.some((f) => f !== 'expired');
      if (invalidClass) {
        return finish('invalid', { failures: [...failures, signature.code] });
      }
      if (expired) {
        return finish('expired', { failures: [...failures, signature.code] });
      }
      return finish('unknown', { failures: [signature.code] });
    }
    if (signature.kind === 'mismatch') {
      failures.push('signature_mismatch');
    }
    failures.push(...dateFailures());

    const invalidFailures = failures.filter((f) => f !== 'expired');
    if (invalidFailures.length > 0) {
      return finish('invalid');
    }

    // Step 5, replay (SPEC 3.3), evaluated BEFORE the expired return
    // (7.5 review M1): 'invalid' outranks 'expired', so a nonce that
    // was already claimed makes an otherwise-expired attestation
    // invalid, not expired. The store contract is a single atomic
    // claim (B2). A store that throws is caller infrastructure
    // failing: fail closed as 'unknown' + lookup_failed (M2), except
    // that an established expiry still outranks it.
    if (opts.nonceStore) {
      let claimed: boolean;
      try {
        claimed = await opts.nonceStore.claim(payload.nonce, wallet, payload.expiresAt);
      } catch {
        if (expired) {
          return finish('expired', { failures: [...failures, 'lookup_failed'] });
        }
        return finish('unknown', { failures: ['lookup_failed'] });
      }
      if (!claimed) {
        return finish('invalid', { failures: [...failures, 'replay_detected'] });
      }
    }

    if (expired) {
      // Expired outranks the lookup outcome (SPEC 3.3 precedence), so
      // the network check is not run.
      return finish('expired');
    }

    // Step 6, registration.
    if (opts.checkRegistration === false) {
      return finish('verified', { failures: [] });
    }
    const outcome = await lookup(wallet, opts.signal);
    if (outcome.state === 'unknown') {
      return finish('unknown', {
        failures: [outcome.code],
        latencyMs: outcome.latencyMs,
      });
    }
    if (outcome.state === 'unregistered') {
      // A valid signature from an unregistered wallet attests nothing.
      return finish('unregistered', {
        failures: ['not_registered'],
        latencyMs: outcome.latencyMs,
      });
    }
    return finish('verified', {
      failures: [],
      humanId: outcome.humanId,
      latencyMs: outcome.latencyMs,
    });
  }

  async function resolveStatus(
    subject: StatusSubject,
    opts?: { signal?: AbortSignal },
  ): Promise<VerifyResult> {
    if (subject.kind === 'address') {
      return verifyAddress(subject.address, opts);
    }
    if (subject.kind === 'attestation') {
      const presented = (subject.attestation as { payload?: { subject?: unknown } })
        ?.payload?.subject as { type?: unknown; id?: unknown } | undefined;
      const expectedSubject =
        presented && typeof presented.type === 'string' && typeof presented.id === 'string'
          ? { type: presented.type, id: presented.id }
          : undefined;
      return verifyAttestation(subject.attestation, {
        ...(expectedSubject ? { expectedSubject } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    }
    // attested_subject: resolve, then verify with the subject as the
    // expectation (SPEC 3.5). The resolver runs under the same
    // deadline/abort race as the AgentBook lookup and receives the
    // caller's signal (7.5 review M3): a hanging resolver must not
    // hold resolveStatus open past timeoutMs.
    const resolved = await raceDeadline(
      () => subject.resolveAttestation(subject.subject, opts?.signal),
      timeoutMs,
      opts?.signal,
    );
    if (resolved.kind === 'timeout') {
      return buildResult({
        status: 'unknown',
        address: ZERO_ADDRESS,
        failures: ['lookup_timeout'],
      });
    }
    if (resolved.kind !== 'value') {
      return buildResult({
        status: 'unknown',
        address: ZERO_ADDRESS,
        failures: ['lookup_failed'],
      });
    }
    // A resolver returning undefined means the same as null (7.5
    // review m1): no attestation for this subject.
    if (resolved.value == null) {
      return buildResult({
        status: 'unknown',
        address: ZERO_ADDRESS,
        failures: ['attestation_not_found'],
      });
    }
    return verifyAttestation(resolved.value, {
      expectedSubject: subject.subject,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }

  return { verifyAddress, verifyAttestation, resolveStatus };
}
