import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  TimeoutError as ViemTimeoutError,
  createPublicClient,
  getAddress,
  hashMessage,
  http,
  isAddress,
  recoverMessageAddress,
  type Hex,
} from 'viem';
import { worldchain } from 'viem/chains';
import {
  MAX_EIP1271_SIGNATURE_BYTES,
  canonicalAttestationMessage,
  validateSignedAttestation,
} from './canonical.js';
import { hashHumanId, truncateAddress } from './hash.js';
import { AGENTBOOK_CONTRACT, assertRpcUrlAllowed, createLiveReader } from './reader.js';
import type {
  CheckEvidence,
  EvmAddress,
  FailureCode,
  RegistrationLookupFact,
  SignedAttestation,
  SignedMessageResult,
  StatusSubject,
  VerificationStatus,
  VerifyAttestationOptions,
  VerifyCoreOptions,
  VerifyResult,
  VerifySignedMessageInput,
  Verifier,
} from './types.js';

const ZERO_ADDRESS: EvmAddress = '0x0000000000000000000000000000000000000000';
const ERC1271_MAGIC: string = '0x1626ba7e';
const MAX_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
// The canonical humanId shape (SPEC 3.1/3.5): 0x-prefixed 32-byte
// hex. Anything a reader resolves that is not null and not this
// shape is garbage, not a registration (7.5 re-review N1).
const HUMAN_ID_SHAPE = /^0x[0-9a-fA-F]{64}$/;

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
  | { kind: 'failed'; error: unknown };

// Run an async operation against the verifier's deadline and an
// optional caller AbortSignal. The operation is invoked INSIDE the
// guarded region (7.5 review M12): a collaborator that throws
// synchronously — before returning its promise — is a 'failed'
// outcome, never an exception escaping a function whose contract is
// "returns a result". A collaborator that returns a plain value
// instead of a promise is normalised by Promise.resolve (7.5
// re-review N2): the value is the outcome, never a TypeError from
// calling .catch on a non-promise. A late rejection after the
// deadline wins is swallowed so it never surfaces as an unhandled
// rejection.
async function raceDeadline<T>(
  start: () => Promise<T> | T,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RaceOutcome<T>> {
  let call: Promise<T>;
  try {
    call = Promise.resolve(start());
  } catch (error) {
    return { kind: 'failed', error };
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
        (error: unknown) => ({ kind: 'failed' as const, error }),
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

function isErc1271Rejection(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk(
      (cause) =>
        cause instanceof ContractFunctionRevertedError ||
        cause instanceof ContractFunctionZeroDataError,
    ) !== null
  );
}

function isRpcTimeout(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk((cause) => cause instanceof ViemTimeoutError) !== null
  );
}

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

  // The injected clock is a collaborator like any other (7.5
  // re-review N2): a throwing now(), or one returning a non-Date
  // or an invalid Date, must not escape a verify call. Fall back
  // to the system clock for that call.
  function safeNow(): Date {
    try {
      const value = now();
      if (value instanceof Date) {
        const ms = value.getTime();
        // The typeof/finiteness test is the substance (fix pass 3,
        // NF-C): Number.isNaN does not coerce, so a fake Date whose
        // getTime() returns a string passed the old guard, and the
        // TypeError from its toISOString() then escaped both entry
        // points. Returning a fresh Date over the validated number
        // also means a forged prototype never reaches toISOString.
        if (typeof ms === 'number' && Number.isFinite(ms)) return new Date(ms);
      }
    } catch {
      // fall through to the system clock
    }
    return new Date();
  }

  const publicClient = createPublicClient({
    chain: worldchain,
    transport: http(options.rpcUrl, { retryCount: 0, timeout: timeoutMs }),
  });

  // ERC-1271 validation for a smart-wallet signer. Both RPC calls share
  // one deadline, with the same timeout/abort race as AgentBook (7.5
  // review B1): a hanging eth_call must not hold verifyAttestation open
  // past timeoutMs. Distinguish three outcomes honestly: the contract
  // answered (match/mismatch), the contract definitively rejected the
  // call (mismatch), or the network could not answer at all (unknown).
  // A viem readContract error can wrap either a revert or a transport
  // failure; treating every rejection as a bad signature is unsound.
  async function erc1271Check(
    wallet: EvmAddress,
    message: string,
    signature: string,
    signal?: AbortSignal,
  ): Promise<SignatureOutcome> {
    // The configured RPC is the trust oracle for this answer too; the
    // chain-id call is a misconfiguration guard (it catches an endpoint
    // answering for another chain), not an authentication of the RPC.
    const deadlineAt = performance.now() + timeoutMs;
    const remaining = () => Math.max(0, deadlineAt - performance.now());
    const chain = await raceDeadline(() => publicClient.getChainId(), remaining(), signal);
    if (chain.kind === 'timeout') return { kind: 'unknown', code: 'lookup_timeout' };
    if (chain.kind === 'failed' && isRpcTimeout(chain.error)) {
      return { kind: 'unknown', code: 'lookup_timeout' };
    }
    if (chain.kind !== 'value') return { kind: 'unknown', code: 'lookup_failed' };
    if (chain.value !== worldchain.id) return { kind: 'unknown', code: 'lookup_failed' };
    if (remaining() === 0) return { kind: 'unknown', code: 'lookup_timeout' };
    const read = await raceDeadline(
      () =>
        publicClient.readContract({
          address: wallet,
          abi: ERC1271_ABI,
          functionName: 'isValidSignature',
          args: [hashMessage(message), signature as Hex],
        }),
      remaining(),
      signal,
    );
    if (read.kind === 'timeout') return { kind: 'unknown', code: 'lookup_timeout' };
    if (read.kind === 'aborted') return { kind: 'unknown', code: 'lookup_failed' };
    if (read.kind === 'failed') {
      if (isErc1271Rejection(read.error)) return { kind: 'mismatch' };
      return { kind: 'unknown', code: isRpcTimeout(read.error) ? 'lookup_timeout' : 'lookup_failed' };
    }
    return read.value.toLowerCase() === ERC1271_MAGIC
      ? { kind: 'match' }
      : { kind: 'mismatch' };
  }

  // Shared EIP-191 recovery for attestations and arbitrary signed
  // messages. No RPC or AgentBook lookup runs on this path.
  async function recoverSigner(message: string, signature: string): Promise<EvmAddress | null> {
    try {
      return await recoverMessageAddress({ message, signature: signature as Hex });
    } catch {
      return null;
    }
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
    const recovered = await recoverSigner(message, attestation.signature);
    return recovered === wallet ? { kind: 'match' } : { kind: 'mismatch' };
  }

  function evidence(latencyMs?: number): CheckEvidence {
    return {
      checkedAt: safeNow().toISOString(),
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
    registration?: RegistrationLookupFact;
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
      ...(args.registration !== undefined ? { registration: args.registration } : {}),
    };
  }

  async function lookup(
    address: EvmAddress,
    signal?: AbortSignal,
  ): Promise<LookupOutcome> {
    const start = Date.now();
    const latency = () => Date.now() - start;
    if (signal?.aborted) {
      // A signal already aborted at entry wins over a collaborator
      // that resolves instantly (fix pass 3, NF-G): inside the race
      // an already-resolved deadline and an already-resolved call
      // settle in attachment order, not in importance, so the race
      // alone cannot promise this ordering.
      return { state: 'unknown', code: 'lookup_failed', latencyMs: 0 };
    }
    const outcome = await raceDeadline(() => reader.lookupHuman(address), timeoutMs, signal);
    switch (outcome.kind) {
      case 'value': {
        // Fail closed on the VALUE (7.5 re-review N1): null is the
        // one unregistered signal; a string in the canonical
        // humanId shape is a registration; ANYTHING else a reader
        // resolves — undefined, a number, a malformed string — is
        // a lookup failure. A non-null garbage value must never be
        // hashed into a 'verified' result.
        const value: unknown = outcome.value;
        if (value === null) return { state: 'unregistered', latencyMs: latency() };
        if (typeof value === 'string' && HUMAN_ID_SHAPE.test(value)) {
          // The chain returns a uint256. Hex letter case is only a
          // presentation choice and must not split one human hash.
          return { state: 'registered', humanId: value.toLowerCase(), latencyMs: latency() };
        }
        return { state: 'unknown', code: 'lookup_failed', latencyMs: latency() };
      }
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
    // The step-6 lookup's fate, recorded for the SPEC 11.2 checks
    // projection (fix pass 3, D6). Assigned when the pipeline
    // reaches step 6; stays undefined on earlier returns, which is
    // itself the fact that the lookup never ran.
    let registration: RegistrationLookupFact | undefined;
    const finish = (status: VerificationStatus, extra: Partial<Parameters<typeof buildResult>[0]> = {}) =>
      buildResult({
        status,
        address: wallet,
        failures,
        ...(disclosure !== undefined ? { disclosure } : {}),
        ...(registration !== undefined ? { registration } : {}),
        ...extra,
      });

    // Step 2, binding (SPEC 3.3). Expected-wallet comparison is on the
    // normalised (lowercased) forms (7.5 review m2): a differently-cased
    // or bad-checksum spelling of the same address is the same wallet,
    // and a non-string expectation is a mismatch, never a throw.
    if (opts.expectedSubject !== undefined) {
      // A null or malformed expectation fails closed (fix pass 3,
      // NF-F), symmetric with expectedWallet below: a caller that
      // builds the expectation from untrusted data must not
      // silently lose the binding check.
      const expected: unknown = opts.expectedSubject;
      const matches =
        typeof expected === 'object' &&
        expected !== null &&
        (expected as { type?: unknown }).type === payload.subject.type &&
        (expected as { id?: unknown }).id === payload.subject.id;
      if (!matches) failures.push('subject_mismatch');
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
    const nowMs = safeNow().getTime();
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
      // The replay step (SPEC 3.3 step 5) still runs on this path
      // (7.5 re-review M1): the read-only has() consumes nothing,
      // so a nonce claimed by an earlier verified presentation is
      // reported as a replay rather than masked by the signature
      // stage's network failure. It runs even when a binding or
      // date failure coexists (fix pass 3, NF-D): returning early
      // for the invalid class skipped the read and masked the
      // replay. A store failure here changes nothing - the
      // signature outcome already determines the result below.
      // When the replay fires, the uncertain signature code is
      // preserved alongside it (merge decision, Oct 27, 2026):
      // consumers must not infer the signature passed, and the
      // collection rule gathers every applicable code.
      if (opts.nonceStore) {
        const store = opts.nonceStore;
        const has = await raceDeadline(
          () => store.has(payload.nonce, wallet),
          timeoutMs,
          opts.signal,
        );
        if (has.kind === 'value' && has.value === true) {
          return finish('invalid', {
            failures: [...failures, signature.code, 'replay_detected'],
          });
        }
      }
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
      // The replay read runs on the signature-mismatch path too
      // (fix pass 3, D8): a replayed nonce under a bad signature
      // collects replay_detected alongside signature_mismatch,
      // exactly as the signature-unknown path above collects it —
      // the two signature-failure paths must not disagree about
      // whether a replay happened. Read-only: consumes nothing.
      if (opts.nonceStore && failures.includes('signature_mismatch')) {
        const store = opts.nonceStore;
        const has = await raceDeadline(
          () => store.has(payload.nonce, wallet),
          timeoutMs,
          opts.signal,
        );
        if (has.kind === 'value' && has.value === true) {
          failures.push('replay_detected');
        }
      }
      return finish('invalid');
    }

    // Step 5, replay (SPEC 3.3): a read-only check establishes replay
    // before expiry and registration, without consuming a fresh nonce.
    // The final atomic claim below still decides concurrent attempts.
    if (opts.nonceStore) {
      // The store is a collaborator under the same deadline race
      // as every other (7.5 re-review N2): a hanging has() is cut
      // at the deadline, a throwing/aborting one is a failure, and
      // a non-boolean resolution is a contract violation — all
      // fail closed, none escape or hang the verification. Every
      // store failure maps to lookup_failed (fix pass 3, D1/D2):
      // SPEC 3.3 pins the store's failure code with no timeout
      // carve-out; lookup_timeout belongs to the chain/RPC reads.
      const store = opts.nonceStore;
      const has = await raceDeadline(
        () => store.has(payload.nonce, wallet),
        timeoutMs,
        opts.signal,
      );
      if (has.kind === 'value' && has.value === true) {
        return finish('invalid', { failures: [...failures, 'replay_detected'] });
      }
      if (has.kind !== 'value' || typeof has.value !== 'boolean') {
        const code: FailureCode = 'lookup_failed';
        if (expired) {
          return finish('expired', { failures: [...failures, code] });
        }
        return finish('unknown', { failures: [code] });
      }
    }

    if (expired) {
      // Expired outranks the lookup outcome (SPEC 3.3 precedence), so
      // the network check is not run.
      return finish('expired');
    }

    // Step 6, registration. Only a successful lookup (or an explicit
    // checkRegistration=false) may consume the nonce. A lookup can
    // cross expiresAt, so recheck the clock before interpreting it —
    // and the recheck happens BEFORE the claim (fix pass 3, NF-A):
    // the claim is the last mutating action before a verified
    // return, so an expiry that crossed during the lookup returns
    // here, without any claim call, and an 'expired' outcome never
    // burns the nonce. The store's own clock check inside claim()
    // closes the remaining gap between this recheck and its atomic
    // write, so a stale verifier cannot make a nonce persist past
    // expiry either.
    const outcome = opts.checkRegistration === false
      ? undefined
      : await lookup(wallet, opts.signal);
    registration =
      opts.checkRegistration === false
        ? { ran: false }
        : {
            ran: true,
            outcome:
              outcome?.state === 'registered'
                ? 'registered'
                : outcome?.state === 'unregistered'
                  ? 'unregistered'
                  : 'failed',
          };
    if (expiresMs <= safeNow().getTime()) {
      // Expiry crossed during the lookup. A simultaneous lookup
      // failure is collected, not discarded (fix pass 3, D5): in
      // check order, the date code precedes the registration code.
      // (`failures` is empty here by construction — every earlier
      // non-date failure already returned.)
      const crossed: FailureCode[] = ['expired'];
      if (outcome?.state === 'unknown') crossed.push(outcome.code);
      return finish('expired', {
        failures: crossed,
        ...(outcome ? { latencyMs: outcome.latencyMs } : {}),
      });
    }
    if (outcome?.state === 'unknown') {
      return finish('unknown', { failures: [outcome.code], latencyMs: outcome.latencyMs });
    }
    if (outcome?.state === 'unregistered') {
      return finish('unregistered', {
        failures: ['not_registered'],
        latencyMs: outcome.latencyMs,
      });
    }
    if (opts.nonceStore) {
      // The claim runs under the deadline race (7.5 re-review N2).
      // Every non-'claimed' outcome fails closed as unknown: a
      // throwing store, a resolution outside the NonceClaimResult
      // union, and a claim whose response is lost or timed out —
      // which SPEC 3.3 treats as possibly consumed — all map to
      // lookup_failed, with no timeout carve-out (fix pass 3,
      // D1/D2) and no release and no retry (SPEC 3.3).
      const store = opts.nonceStore;
      const claim = await raceDeadline(
        () => store.claim(payload.nonce, wallet, payload.expiresAt),
        timeoutMs,
        opts.signal,
      );
      if (claim.kind === 'value' && claim.value === 'replay') {
        return finish('invalid', { failures: ['replay_detected'] });
      }
      if (claim.kind === 'value' && claim.value === 'expired') {
        return finish('expired', { failures: ['expired'] });
      }
      if (claim.kind !== 'value' || claim.value !== 'claimed') {
        return finish('unknown', { failures: ['lookup_failed'] });
      }
    }
    return finish('verified', {
      failures: [],
      ...(outcome?.state === 'registered'
        ? { humanId: outcome.humanId, latencyMs: outcome.latencyMs }
        : {}),
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

  // D5 (SPEC 3.6 amendment): verify one arbitrary caller-canonicalised
  // message without AgentBook, attestation, expiry, or replay semantics.
  // The caller declares the signature path; there is no EOA-to-contract
  // fallback and no human identifier in the result.
  async function verifySignedMessage(input: VerifySignedMessageInput): Promise<SignedMessageResult> {
    const fail = (
      failures: FailureCode[],
      address: EvmAddress | null = null,
    ): SignedMessageResult => ({ verified: false, address, failures });

    if (typeof input !== 'object' || input === null) {
      return fail(['signature_mismatch']);
    }
    const { message, signature, signatureType, expectedAddress } = input;

    let expected: EvmAddress | undefined;
    if (expectedAddress !== undefined) {
      if (typeof expectedAddress !== 'string' || !isAddress(expectedAddress)) {
        return fail(['malformed_address']);
      }
      try {
        expected = getAddress(expectedAddress);
      } catch {
        return fail(['malformed_address']);
      }
    }

    if (signatureType === 'eoa') {
      const recovered =
        typeof message === 'string' && typeof signature === 'string'
          ? await recoverSigner(message, signature)
          : null;
      if (recovered === null) return fail(['signature_mismatch']);
      if (expected !== undefined && recovered !== expected) {
        return fail(['subject_mismatch'], recovered);
      }
      return { verified: true, address: recovered, failures: [] };
    }

    if (signatureType === 'erc1271') {
      // No recovery is possible for a contract signer: a named contract
      // is required, and malformed bytes must fail before any RPC call.
      if (expected === undefined) return fail(['signature_mismatch']);
      if (
        typeof message !== 'string' ||
        typeof signature !== 'string' ||
        !/^0x(?:[0-9a-fA-F]{2})*$/.test(signature)
      ) {
        return fail(['signature_mismatch'], expected);
      }
      // The attestation shape gate's cap applies here too (fix
      // pass 3, NF-E): an unbounded caller-supplied byte string
      // forwarded into an eth_call is the same DoS surface on this
      // path, and an empty signature is not a signature — '0x'
      // previously sailed through to the contract call.
      const signatureBytes = (signature.length - 2) / 2;
      if (signatureBytes === 0 || signatureBytes > MAX_EIP1271_SIGNATURE_BYTES) {
        return fail(['signature_mismatch'], expected);
      }
      const outcome = await erc1271Check(expected, message, signature);
      if (outcome.kind === 'unknown') return fail([outcome.code], expected);
      if (outcome.kind === 'mismatch') return fail(['signature_mismatch'], expected);
      return { verified: true, address: expected, failures: [] };
    }

    return fail(['signature_mismatch']);
  }

  return { verifyAddress, verifyAttestation, resolveStatus, verifySignedMessage };
}
