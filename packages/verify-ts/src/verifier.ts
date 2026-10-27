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
import { canonicalAttestationMessage, validateSignedAttestation } from './canonical.js';
import { hashHumanId, truncateAddress } from './hash.js';
import { AGENTBOOK_CONTRACT, createLiveReader } from './reader.js';
import type {
  CheckEvidence,
  EvmAddress,
  FailureCode,
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

class LookupTimeoutError extends Error {}

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
    error instanceof LookupTimeoutError ||
    (error instanceof BaseError &&
      error.walk((cause) => cause instanceof ViemTimeoutError) !== null)
  );
}

type LookupOutcome =
  | { state: 'registered'; humanId: string; latencyMs: number }
  | { state: 'unregistered'; latencyMs: number }
  | { state: 'unknown'; code: 'lookup_failed' | 'lookup_timeout'; latencyMs: number };

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
    // and only here (SPEC 3.0).
    throw new TypeError(`createVerifier: malformed contract address: ${contract}`);
  }
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
    transport: http(options.rpcUrl, { retryCount: 0, timeout: timeoutMs }),
  });

  async function erc1271Valid(
    wallet: EvmAddress,
    message: string,
    signature: string,
  ): Promise<boolean> {
    const check = async () => {
      // Chain identity and the contract read share one deadline. A
      // non-World Chain RPC is an unchecked signature, not a mismatch.
      if (await publicClient.getChainId() !== worldchain.id) {
        throw new Error('ERC-1271 RPC is not World Chain.');
      }
      try {
        const result = await publicClient.readContract({
          address: wallet,
          abi: ERC1271_ABI,
          functionName: 'isValidSignature',
          args: [hashMessage(message), signature as Hex],
        });
        return result.toLowerCase() === ERC1271_MAGIC;
      } catch (error) {
        // A definitive contract revert or empty result rejects the
        // signature. Transport and ambiguous execution errors cannot
        // establish a mismatch, so callers report an unchecked result.
        if (isErc1271Rejection(error)) return false;
        throw error;
      }
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new LookupTimeoutError()), timeoutMs);
    });
    try {
      return await Promise.race([check(), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // EIP-191 recovery, shared by verifyAttestation and
  // verifySignedMessage so there is exactly one recovery path in the
  // package (SPEC 3.6 amendment). Returns the checksummed signer, or
  // null when the signature is not EOA-recoverable at all.
  async function recoverSigner(
    message: string,
    signature: string,
  ): Promise<EvmAddress | null> {
    try {
      return await recoverMessageAddress({
        message,
        signature: signature as Hex,
      });
    } catch {
      return null;
    }
  }

  async function signatureValid(
    attestation: SignedAttestation,
    message: string,
  ): Promise<boolean> {
    const wallet = attestation.payload.agentWalletAddress;
    const recovered = await recoverSigner(message, attestation.signature);
    if (recovered === wallet) return true;
    // Not an EOA signature for this wallet; fall through to ERC-1271.
    return erc1271Valid(wallet, message, attestation.signature);
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
    const call = reader.lookupHuman(address);
    // If the deadline wins the race, the underlying call may reject
    // later; swallow that late rejection so it never surfaces as an
    // unhandled rejection in the host process.
    call.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new LookupTimeoutError()), timeoutMs);
      if (signal) {
        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        onAbort = () => reject(new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    try {
      const value = await Promise.race([call, deadline]);
      if (value === null) return { state: 'unregistered', latencyMs: latency() };
      return { state: 'registered', humanId: value, latencyMs: latency() };
    } catch (err) {
      if (err instanceof LookupTimeoutError) {
        return { state: 'unknown', code: 'lookup_timeout', latencyMs: latency() };
      }
      return { state: 'unknown', code: 'lookup_failed', latencyMs: latency() };
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
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

    // Step 2, binding (SPEC 3.3).
    if (
      opts.expectedSubject &&
      (opts.expectedSubject.type !== payload.subject.type ||
        opts.expectedSubject.id !== payload.subject.id)
    ) {
      failures.push('subject_mismatch');
    }
    if (opts.expectedWallet) {
      let expected: string;
      try {
        expected = getAddress(opts.expectedWallet);
      } catch {
        expected = opts.expectedWallet.toLowerCase();
      }
      if (expected !== wallet) failures.push('wallet_mismatch');
    }

    // Step 3, signature over the canonical form.
    const message = canonicalAttestationMessage(payload);
    let signatureMatches: boolean;
    try {
      signatureMatches = await signatureValid(envelope.attestation, message);
    } catch (error) {
      return buildResult({
        status: 'unknown',
        address: wallet,
        failures: [isRpcTimeout(error) ? 'lookup_timeout' : 'lookup_failed'],
        ...(disclosure !== undefined ? { disclosure } : {}),
      });
    }
    if (!signatureMatches) {
      failures.push('signature_mismatch');
    }

    // Step 4, dates and the protocol lifetime cap.
    const nowMs = now().getTime();
    const issuedMs = Date.parse(payload.issuedAt);
    const expiresMs = Date.parse(payload.expiresAt);
    if (expiresMs <= issuedMs || expiresMs - issuedMs > MAX_LIFETIME_MS) {
      failures.push('malformed_attestation');
    }
    if (issuedMs > nowMs + clockSkewMs) failures.push('not_yet_valid');
    const expired = expiresMs <= nowMs;
    if (expired) failures.push('expired');

    const invalidFailures = failures.filter((f) => f !== 'expired');
    if (invalidFailures.length > 0) {
      return buildResult({
        status: 'invalid',
        address: wallet,
        failures,
        ...(disclosure !== undefined ? { disclosure } : {}),
      });
    }
    if (expired) {
      // Expired outranks the lookup outcome (SPEC 3.3 precedence), so the
      // network check is not run.
      return buildResult({
        status: 'expired',
        address: wallet,
        failures,
        ...(disclosure !== undefined ? { disclosure } : {}),
      });
    }

    // Step 5, replay. A supplied nonce store is caller infrastructure;
    // its own errors propagate as programmer/infra errors, not verdicts.
    if (opts.nonceStore && (await opts.nonceStore.has(payload.nonce, wallet))) {
      return buildResult({
        status: 'invalid',
        address: wallet,
        failures: ['replay_detected'],
        ...(disclosure !== undefined ? { disclosure } : {}),
      });
    }

    // Step 6, registration.
    if (opts.checkRegistration === false) {
      if (opts.nonceStore) {
        await opts.nonceStore.add(payload.nonce, wallet, payload.expiresAt);
      }
      return buildResult({
        status: 'verified',
        address: wallet,
        failures: [],
        ...(disclosure !== undefined ? { disclosure } : {}),
      });
    }
    const outcome = await lookup(wallet, opts.signal);
    if (outcome.state === 'unknown') {
      return buildResult({
        status: 'unknown',
        address: wallet,
        failures: [outcome.code],
        latencyMs: outcome.latencyMs,
        ...(disclosure !== undefined ? { disclosure } : {}),
      });
    }
    if (outcome.state === 'unregistered') {
      // A valid signature from an unregistered wallet attests nothing.
      return buildResult({
        status: 'unregistered',
        address: wallet,
        failures: ['not_registered'],
        latencyMs: outcome.latencyMs,
        ...(disclosure !== undefined ? { disclosure } : {}),
      });
    }
    if (opts.nonceStore) {
      await opts.nonceStore.add(payload.nonce, wallet, payload.expiresAt);
    }
    return buildResult({
      status: 'verified',
      address: wallet,
      failures: [],
      humanId: outcome.humanId,
      latencyMs: outcome.latencyMs,
      ...(disclosure !== undefined ? { disclosure } : {}),
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
    // expectation (SPEC 3.5).
    let attestation: SignedAttestation | null;
    try {
      attestation = await subject.resolveAttestation(subject.subject);
    } catch {
      return buildResult({
        status: 'unknown',
        address: ZERO_ADDRESS,
        failures: ['lookup_failed'],
      });
    }
    if (attestation === null) {
      return buildResult({
        status: 'unknown',
        address: ZERO_ADDRESS,
        failures: ['attestation_not_found'],
      });
    }
    return verifyAttestation(attestation, {
      expectedSubject: subject.subject,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }

  // D5 (SPEC 3.6 amendment, Oct 26, 2026): verify an arbitrary
  // caller-canonicalised signed message through the same machinery
  // verifyAttestation uses internally. Signature-only: no AgentBook
  // lookup, no expiry/replay/subject semantics, no humanId in either
  // direction. The caller declares the signature path; a contract
  // address checked through the EOA path fails rather than silently
  // switching to ERC-1271. Never throws for an expected failure.
  async function verifySignedMessage(
    input: VerifySignedMessageInput,
  ): Promise<SignedMessageResult> {
    const fail = (
      failures: FailureCode[],
      address: EvmAddress | null = null,
    ): SignedMessageResult => ({ verified: false, address, failures });

    if (typeof input !== 'object' || input === null) {
      return fail(['signature_mismatch']);
    }
    const { message, signature, signatureType, expectedAddress } = input;

    // A malformed expected address is its own failure, checked before
    // any signature work (mirrors verifyAddress validating its input
    // before the lookup).
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
      if (recovered === null) {
        // Invalid or undecodable signature.
        return fail(['signature_mismatch']);
      }
      if (expected !== undefined && recovered !== expected) {
        return fail(['subject_mismatch'], recovered);
      }
      return { verified: true, address: recovered, failures: [] };
    }

    if (signatureType === 'erc1271') {
      // There is no recovery for a contract signer: the claimed
      // contract address is required, and it is the signer.
      if (expected === undefined) {
        return fail(['signature_mismatch']);
      }
      // Runtime callers can bypass the TypeScript input type. Reject
      // malformed bytes before even checking chain identity; a
      // permissive contract must not authenticate malformed input.
      if (
        typeof message !== 'string' ||
        typeof signature !== 'string' ||
        !/^0x(?:[0-9a-fA-F]{2})*$/.test(signature)
      ) {
        return fail(['signature_mismatch'], expected);
      }
      let valid: boolean;
      try {
        valid = await erc1271Valid(expected, message, signature);
      } catch (error) {
        // The check could not be executed at all (RPC transport
        // failure or a wrong-chain RPC). SPEC 3.6 D5 amendment,
        // pinned Oct 26, 2026 (world-program cba7539): that case is
        // unchecked, not mismatched. A deadline has its existing
        // lookup_timeout code; other failed checks use lookup_failed.
        return fail([isRpcTimeout(error) ? 'lookup_timeout' : 'lookup_failed'], expected);
      }
      if (!valid) {
        return fail(['signature_mismatch'], expected);
      }
      return { verified: true, address: expected, failures: [] };
    }

    // An unrecognised signatureType from an untyped caller: the path
    // cannot be determined, which is a wrong-path signature failure,
    // not a thrown error.
    return fail(['signature_mismatch']);
  }

  return { verifyAddress, verifyAttestation, resolveStatus, verifySignedMessage };
}
