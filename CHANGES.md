# Changes

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
