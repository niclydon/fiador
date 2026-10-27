# Changelog

## 0.3.0 — 2026-10-26

The §7.5 adversarial-review fix pass. The review failed the gate on
the 0.1.0 surface; every item below is a reviewed finding with a
regression test. (0.2.0 is the D5 `verifySignedMessage` release on a
sibling branch; this release is sequenced after it.)

Breaking:

- The nonce store has a read-only, strongly consistent `has(nonce, wallet)` check for
  replay precedence and an atomic
  `claim(nonce, wallet, expiresAt) -> Promise<NonceClaimResult>`, where
  the exported `NonceClaimResult` is `'claimed' | 'replay' | 'expired'`,
  after registration succeeds. The store must use its own clock at
  the atomic write and retain a claim only until `expiresAt` (B2).
  This prevents expired, unregistered, or unchecked attestations
  from consuming a fresh nonce, while concurrent presentations
  still produce at most one verified result. A claimed nonce on an
  expired attestation reports `invalid` + `replay_detected`, per
  SPEC 3.3 precedence (M1). A throwing store fails closed as
  `unknown` + `lookup_failed` instead of throwing (M2).
- `attestation_lifetime_invalid` is a failure code of its own,
  split out of `malformed_attestation` (M6, SPEC 3.0). Consumers
  matching on the old code for over-lifetime documents must match
  the new one.

Fixes:

- `signatureType` is honoured: `eip191` verifies by EIP-191
  recovery only (no RPC, ever); `eip1271` verifies by ERC-1271
  only, accepts any non-empty even-length hex signature (the
  65-byte gate now applies to `eip191` only — Safe and passkey
  signatures were previously rejected as malformed), and runs
  under the same deadline/abort race as the AgentBook lookup, so a
  hanging `eth_call` returns `unknown` + `lookup_timeout` at
  `timeoutMs` instead of hanging (B1). A signature-step network
  failure no longer discards binding failures or pre-empts an
  established expiry. A same-chain HTTP transport failure during
  ERC-1271 validation is `unknown` + `lookup_failed`; a definitive
  contract rejection remains `signature_mismatch`.
- Expiry is checked again after registration and after the final
  nonce claim. A lookup that crosses `expiresAt` returns `expired`
  without consuming the nonce; an atomic claim that finds the
  attestation expired records nothing.
- The attestation envelope and subject objects are closed: keys
  outside `{payload, signature, signatureType}` and
  `{type, id}` are `malformed_attestation` (B3).
- Canonical form: `extra` is serialised manually from entries
  sorted by Unicode code point (UTF-8 byte order), so
  integer-like keys order lexicographically ("1","10","2") and a
  signed `__proto__` key is bound by the signature instead of
  being silently dropped by the prototype setter (M7/M8/m3). All
  pre-existing fixture vectors keep byte-identical canonical
  messages — a baseline regression test pins this.
- Strict calendar validation for `issuedAt`/`expiresAt`:
  impossible dates (2026-02-30) are malformed instead of being
  rolled over by `Date.parse` (M9).
- `resolveStatus` resolvers run under the deadline/abort race and
  receive the caller's `AbortSignal`; a resolver returning
  `undefined` is treated like `null` (M3/m1).
- `reader.lookupHuman` is invoked inside the guarded region of
  the lookup race: a synchronously-throwing reader maps to
  `unknown` + `lookup_failed` (M12).
- `toPublicVerifyResult` enumerates `evidence.agentBook`'s fields
  instead of spreading the object (M13).
- `expectedWallet` compares normalised forms (case/checksum
  spelling of the same address is not a mismatch) and never
  throws on a non-string value (m2).
- Length caps in payload validation: nonce ≤ 128, subject.type
  ≤ 64, subject.id ≤ 256 (m4).
- Default-reader endpoint policy: non-https RPC URLs are rejected
  at construction except on loopback (M17). Documentation now
  states plainly that the configured RPC is the trust oracle for
  registration answers and the chain-id check is a
  misconfiguration guard.

## 0.1.0 — 2026-10-26

Initial implementation of the verify core from the W0 spec:
`createVerifier` with `verifyAddress`, `verifyAttestation`, and
`resolveStatus`; the internal/public result split with
`toPublicVerifyResult` as the only sanctioned crossing; the canonical
attestation signing form (payload v1, EIP-191 with ERC-1271 fallback);
the canonical `humanHash`; a direct viem AgentBook reader that keeps
RPC failure (`unknown`) distinct from non-registration
(`unregistered`); deterministic synthetic fixtures and the failure-case
test suite.
