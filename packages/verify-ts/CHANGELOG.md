# Changelog

## 0.2.0 — 2026-10-26

D5, agreed in the W0 spec's section 3.6 amendment: the verifier
gains `verifySignedMessage({ message, signature, signatureType,
expectedAddress })`, an additive minor. It verifies an arbitrary
caller-canonicalised message through the same signature machinery
`verifyAttestation` uses internally (EIP-191 recovery for EOAs,
ERC-1271 for contract signers, the path caller-declared and never
silently switched), and returns its own small result —
`{ verified, address, failures }` — reusing the existing failure
codes (`signature_mismatch`, `subject_mismatch`,
`malformed_address`). It performs no AgentBook lookup and no
attestation semantics; registration composes through
`verifyAddress`, and freshness and replay are the caller's
protocol's concern. New signed-message fixture vector; test
coverage for both paths, the wrong-path case, and the failure
codes.

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
