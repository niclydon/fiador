# Changelog

## 0.3.0 — 2026-10-26

The §7.5 adversarial-review mirror pass: the Python counterpart of
`@fiador/verify` 0.3.0 (PR #33), mirroring every core behavior change
in that release so the two implementations stay verdict-identical
against the regenerated shared fixture vectors. (0.2.0 was not a
Python release: the port's 0.1.0 already carried the D5
`verify_signed_message` surface that TS shipped as 0.2.0; the
version now tracks the TS core's.)

Breaking:

- The nonce store contract is now a single atomic
  `claim(nonce, wallet, expires_at) -> bool` (True = newly claimed,
  False = replay), replacing the `has`/`add` pair and its
  check-then-set race (B2). Replay is now evaluated before the
  expired return, so a claimed nonce on an expired attestation
  reports `invalid` + `replay_detected` (M1). A store whose `claim`
  raises fails closed as `unknown` + `lookup_failed` instead of
  propagating out of `verify_attestation` (M2).
- `attestation_lifetime_invalid` is a failure code of its own,
  split out of `malformed_attestation` (M6). Consumers matching on
  the old code for over-lifetime documents must match the new one.

Fixes:

- `signature_type` is honoured: `eip191` verifies by EIP-191
  recovery only (no RPC, ever); `eip1271` verifies by ERC-1271
  only, accepts any non-empty even-length hex signature (the
  65-byte gate now applies to `eip191` only), and runs under the
  same deadline/abort race as the AgentBook lookup, so a hanging
  `eth_call` returns `unknown` + `lookup_timeout` at `timeout_ms`
  instead of hanging (B1). A signature-step network failure no
  longer discards binding failures or pre-empts an established
  expiry.
- The attestation envelope and subject objects are closed: keys
  outside `{payload, signature, signatureType}` and `{type, id}`
  are `malformed_attestation` (B3).
- Canonical form: the message is assembled field by field from
  `extra` entries sorted by UTF-8 byte order, so integer-like keys
  order lexicographically ("1","10","2") and a signed `__proto__`
  key is bound by the signature as ordinary data (M7/M8/m3). All
  pre-existing fixture vectors keep byte-identical canonical
  messages, proven by signature recovery over the regenerated
  vectors (which add `extraProtoKey`, `extraIntegerKeys`, and
  `extraAstralKeys`).
- Strict calendar validation for `issued_at`/`expires_at`:
  impossible dates (2026-02-30) are malformed instead of being
  rolled over (M9).
- `resolve_status` resolvers run under the deadline/abort race
  and receive the caller's abort event when they accept a second
  positional argument; a resolver returning None is
  `attestation_not_found` (M3/m1).
- Collaborators are invoked inside the guarded deadline region: a
  synchronously-raising reader maps to `unknown` + `lookup_failed`
  (M12).
- `expected_wallet` compares normalised forms (case/checksum
  spelling of the same address is not a mismatch) and never raises
  on a non-string value (m2).
- Length caps in payload validation: nonce ≤ 128, subject.type
  ≤ 64, subject.id ≤ 256 (m4).
- Default-reader endpoint policy: non-https RPC URLs are rejected
  at construction except on loopback (M17). The `create_verifier`
  contract-address error no longer interpolates the value (M14).

Adaptations (no verdict changes): the ERC-1271 chain-identity call
and `eth_call` share one deadline budget (the TS core races each
separately); `to_public_verify_result` already enumerated
`agent_book`'s fields rather than copying wholesale, and still
does (M13, verified by test rather than changed).

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
