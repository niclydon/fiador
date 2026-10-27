# Changelog

## 0.1.0 — 2026-10-26

Initial release: the Python parity port of `@fiador/verify` 0.1.0,
plus `verify_signed_message` from the W0 spec 3.6 amendment (D5, which
joins the TypeScript surface in `@fiador/verify` 0.2.0; this package's
first release includes it, in the same release train).

- `create_verifier(...)` -> `Verifier` with `verify_address`,
  `verify_attestation`, `resolve_status`, and
  `verify_signed_message`, mirroring the TypeScript core field-for-
  field with snake_case names (W1 DESIGN 4.1).
- Module functions: `to_public_verify_result`,
  `canonical_attestation_message`, `hash_human_id`,
  `truncate_address`, `is_verification_status`.
- Identical semantics to the TS core: same check order, statuses, and
  failure codes; clock skew applies to `issuedAt` only, never to
  expiry; the AgentBook lookup is a direct contract read whose
  transport failures surface as `unknown` + `lookup_failed` /
  `lookup_timeout`, never as `unregistered`.
- Parity is test-proven against the TS package's committed fixture
  vectors, read from the sibling path at test time.
