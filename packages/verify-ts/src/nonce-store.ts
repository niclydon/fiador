import type { EvmAddress, NonceClaimResult } from './types.js';

// Reference in-memory nonce store (7.5 review B2; re-review fix
// pass 2). It implements the VerifyAttestationOptions.nonceStore
// contract — has / claim / release — and ships in the package so
// the contract has an executable reference, not just prose.
//
// Atomicity: claim() performs its check-and-set with NO await in
// between. An async function body runs synchronously until its
// first await, so two concurrent claims for the same key cannot
// interleave between the check and the write: exactly one of them
// observes 'claimed'. A production store must provide the same
// guarantee against its backend — a single conditional write (an
// INSERT ... ON CONFLICT DO NOTHING, a SET NX, a conditional
// update whose affected-row count is the answer). A claim that
// awaits between checking and setting is the forbidden shape; the
// conformance test in test/verify.test.ts (concurrent
// double-presentation against this store and against an awaiting
// store double) is the executable definition.
//
// Lifetime: an entry lapses at the attestation's own expiresAt
// (SPEC 3.3 step 5: a claim is recorded until expiresAt). claim()
// checks the store's own clock at the write point and returns
// 'expired' — recording nothing — when the attestation has
// already expired, so a stale verifier cannot make a nonce
// persist past expiry.
//
// Release (N3): the verifier takes claims only for terminal
// outcomes, so it never calls release itself; the method exists
// for compositions that claim earlier and must free a nonce when
// their outcome is unknown or unregistered.
export class InMemoryNonceStore {
  private readonly claims = new Map<string, number>(); // key -> expiresAt (ms)
  private readonly clock: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.clock = options.now ?? (() => new Date());
  }

  private key(nonce: string, wallet: EvmAddress): string {
    return `${wallet.toLowerCase()}\n${nonce}`;
  }

  // The active claim's expiry for a key, lapsing (and forgetting)
  // entries whose expiresAt has passed.
  private active(key: string): number | undefined {
    const expiresAtMs = this.claims.get(key);
    if (expiresAtMs === undefined) return undefined;
    if (expiresAtMs <= this.clock().getTime()) {
      this.claims.delete(key);
      return undefined;
    }
    return expiresAtMs;
  }

  async has(nonce: string, wallet: EvmAddress): Promise<boolean> {
    return this.active(this.key(nonce, wallet)) !== undefined;
  }

  async claim(
    nonce: string,
    wallet: EvmAddress,
    expiresAt: string,
  ): Promise<NonceClaimResult> {
    // No await between the checks above and the write below:
    // atomic by construction.
    const expiresAtMs = Date.parse(expiresAt);
    if (!(expiresAtMs > this.clock().getTime())) return 'expired';
    const key = this.key(nonce, wallet);
    if (this.active(key) !== undefined) return 'replay';
    this.claims.set(key, expiresAtMs);
    return 'claimed';
  }

  async release(nonce: string, wallet: EvmAddress): Promise<void> {
    this.claims.delete(this.key(nonce, wallet));
  }
}
