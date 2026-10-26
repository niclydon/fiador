# Changes

## 2026-10-26: first build — verify core stub, verifier bot, link preview

- packages/verify-ts: the verify core at the W0 spec's interface
  (createVerifier; verifyAddress / verifyAttestation /
  resolveStatus; internal/public result split with hash-only
  public outputs). Signature verification and the AgentBook
  reader are injected dependencies: the shipped defaults fail
  closed (no attestation verifies, lookups report unknown)
  until the real implementations land.
- verifier-bot: the self-host reference bot scaffold —
  /fiador, /verify-agent, /attest; SQLite guild config and
  check log; Human-backed role sync (revoke on invalid,
  expired, unregistered; never on unknown); SSRF-guarded
  attestation fetching per DESIGN §5.4.
- link-preview: the /v/<short-id> endpoint — content-derived
  ids resolved against the registry, crawl-time verification,
  dynamic OG cards in every state including the not-found and
  could-not-check failure cards, browser click-through to the
  verify page.
- 66 tests across the three packages, all against fakes and
  synthetic fixtures; no live Discord, chain, or DNS in tests.
- Doc correction: docs/DESIGN.md's decisions summary no longer
  describes a canonical signing prefix (the D2 resolution
  adopted the W0 canonical form — the serialised payload
  alone is the message); the Oct 25 entry below carries the
  matching correction note.

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
  prefix. (Corrected Oct 26, 2026: the prefix belonged to the
  design's first revision only. Under the D2 resolution the
  canonical form is the W0 ordered-keys serialisation alone,
  with no prefix; see docs/DESIGN.md §3.2 and §13 D2. No
  attestation has been signed under either form.)

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
