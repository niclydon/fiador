# Changelog

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
