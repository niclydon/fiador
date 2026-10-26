# Changes

## 2026-10-26: verify core and verify MCP implemented (W0)

- `packages/verify-ts` (`@fiador/verify` 0.1.0): the verify core
  per the W0 spec — `verifyAddress`, `verifyAttestation`,
  `resolveStatus`, the internal/public result split with
  `toPublicVerifyResult` as the only public crossing, the
  canonical attestation signing form and canonical `humanHash`,
  and a direct viem AgentBook reader that keeps RPC failure
  (`unknown`) distinct from non-registration (`unregistered`);
  the AgentKit SDK 0.2.1 verifier collapses the two, so the core
  does not wrap it. Deterministic synthetic fixtures and a
  32-test failure-case suite.
- `packages/verify-mcp` (`@fiador/verify-mcp` 0.1.0): the
  section 11 MCP server — `verify_address`, `verify_attestation`
  (with the per-check breakdown), `badge_status` (listed only
  when a resolver is configured; badge URLs only when a badge
  base is configured, per the open M2 default). stdio and
  stateless streamable HTTP transports, parity-tested.
- Live verification recorded in `docs/verification.md`: the
  program wallet verifies against the real AgentBook contract,
  through the library and through both MCP transports.

## 2026-10-25: renamed to Fiador; build design lands

- Project renamed human-backed -> Fiador (the guarantor who
  stands surety for another): repo renamed on GitHub, README
  and spec wording, NOTICE product line, badge artwork label
  now reads "fiador", asset files renamed to fiador-*.
  "human-backed" remains descriptive prose where plainly
  generic; the Discord role label is unchanged ("Human-backed").
- docs/DESIGN.md added: the build-ready design for the verify
  package, attestation format, self-host verifier bot, static
  verify page, and badge service, with all settled decisions
  recorded (Apache-2.0, hash-only humanId, self-host v1,
  optional operator display name, light and dark modes).
- One format consequence of the rename: the attestation
  canonical signing prefix is fiador-discord-attestation:v1,
  fixed before any attestation has been signed under the old
  prefix.

## 2026-10-25: founding

- Repository created as the public home of the human-backed
  protocol: founding README, protocol specification
  (docs/SPEC.md), badge asset set (verified / expired /
  unverified, pill and icon, light and dark), LICENSE (Apache-2.0)
  and NOTICE, and the founding narrative entry
  (docs/narrative/2026-10-25-founding.md).
- No code yet. Implementation begins with the verify package,
  extracted from a privately tested AgentKit prototype, followed
  by the static verify page and the self-hosted verifier bot, per
  the build order in the spec.
