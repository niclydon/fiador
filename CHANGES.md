# Changes

## 2026-10-27: static privacy and support pages published

- Published the eight-file static release from branch commit
  `9b5bc30781333376f8bea1459f03d5069e201858` to fiador.org and
  www.fiador.org after the operator approved production publication.
  This was a direct Vercel deployment, not a merge into `main`;
  draft PR #26 remains open.
- Live `/privacy/` and `/support/` returned 200. The registry and
  founding attestation matched the release branch's public files
  byte for byte; `/verify/`, `/v/example`, and `/api/preview` remained
  404. The canonical repo registry still differs from its deployed
  mirror. This release added public information pages; it did not
  establish live Slack sign-in, a World ID check, or bot control. See
  `docs/narrative/2026-10-27-static-privacy-support-release.md` and
  `docs/verification.md` for the release boundary and smoke results.

## 2026-10-26: dynamic badge service (W0 SPEC section 4)

- badge-service/: a top-level, keyless app over the public exports of
  @fiador/verify. It serves SVG and PNG badges, public JSON status,
  health, and an explainer. Its Discord application badge stays
  neutral even when an operator wallet check passes, because that
  check does not prove control of the named application.
- The canonical `entries[]` registry is read from a file or fetched
  over guarded HTTPS. Registry and attestation sources are refreshed
  within 300 seconds, with shared concurrent fetches and cancellation
  of queued source work after all callers time out. The full request
  has a five-second deadline; failures produce neutral, uncached art.
  A local registry is reread and validated at each refresh so an
  unchanged healthy file remains fresh past 24 hours; failed reloads
  still expire the last good entries after 24 hours.
- An over-limit request reuses observed artwork only until that
  check's original cache deadline; PNG fallbacks are separate for
  each theme and variant. Address status omits a badge URL rather
  than linking to an unverifiable truncated address. Badge base URLs
  reject credentials, queries, and fragments. The badge registry and
  address response differ from the MCP server's current contract;
  sections 4.2 and 11 parity remains later work.
- The integrated badge-service suite has 78 route, source, and
  security tests. Badge checks are configured in CI on Node 22 and 24.
  Nothing was deployed; no public badge instance is claimed.

## 2026-10-26: verifier bot safety and maintenance

- The bot checks and logs operator claims without creating a new
  binding or changing a Discord role. A valid wallet signature alone
  does not establish control of the named application. This corrects
  the role-sync description in the first-build entry below.
- Audit delivery now checks that the configured log channel belongs
  to the originating guild. A channel from another guild or a DM
  cannot receive that guild's check line.
- `/attest` and `/verify-agent` share a five-check budget per user,
  guild, and ten-minute window. The bot prunes check-log rows older
  than 90 days at startup and daily. Periodic checks run on each
  guild's own schedule, with jitter and a four-guild concurrency cap.
- The exact bot maintenance head passed local build, typecheck, and
  51 bot tests. GitHub CI passed on Node 22 and 24; independent
  correctness and security reviews found no blockers. No live
  multi-guild Discord run or application-control proof is claimed.
  See docs/narrative/2026-10-26-bot-safety.md.

## 2026-10-26: founding attestation published (§9 step 1)

- registry/: the first entry — Discord application
  1561422752521396254 (Nova) pointing at
  https://fiador.org/attestations/nova.json — plus the JSON
  Schema for the §3.4 format and the contribution rules
  (verifies + schema-valid = listed; tombstone as the
  recommended removal path).
- verify-page/: the minimal static hosting root for
  fiador.org (Vercel) — a one-page front door with the
  descriptor and the honest limits, the founding attestation
  served byte-for-byte at /attestations/nova.json, and the
  registry mirrored at /registry.json. The full §6.1 verify
  page is later work.
- The founding attestation was signed with the dedicated demo
  signing wallet via tools/signer and live-verified at
  signing time: status verified, 2026-10-26T10:10:50Z,
  payload hash
  8bfeb9f9182de3ce63cdf42bdff941277250d96089982c65f0f97761f195a031,
  expires 2027-01-24. Narrative:
  docs/narrative/2026-10-26-founding-attestation.md.
- DESIGN §9 precondition synced: the demo signing wallet's
  AgentBook registration is recorded as done (Oct 26, 2026,
  live-verified), replacing the stale awaiting-the-tap text.

## 2026-10-26: reference signer CLI (tools/signer)

- tools/signer: the reference signer from DESIGN §3.2 —
  draft, sign, and verify subcommands built entirely on the
  merged verify core (canonicalAttestationMessage,
  createVerifier); no cryptography or hashing is reimplemented.
- draft runs the core live against the wallet and copies the
  internal result humanHash into the payload (human_id_hash in
  extra, disclosure pinned to hash, operator display name only
  via explicit opt-in, expiry capped at 90 days, 192-bit nonce).
- sign refuses before signing when the key does not control
  the draft wallet, the wallet is unregistered at signing
  time, the payload hash is stale against a fresh lookup, the
  draft is expired, or disclosure is not hash. The key is
  loaded from an env file, never an argument, never printed;
  the CLI never handles a raw humanId.
- verify prints only the public projection of the result.
- Founding draft produced with this CLI for the Nova Discord
  application (payload hash
  8bfeb9f9182de3ce63cdf42bdff941277250d96089982c65f0f97761f195a031);
  signing and publication land in the follow-up publish PR.
- 11 tests (root suite 93 passed, 3 skipped): draft shape and
  live-hash derivation, opt-in name, unregistered refusal,
  90-day cap, sign-to-verify round trip through the real core
  with a fake reader, the sign refusals, and an output-hygiene
  scan asserting no raw humanId and no key material in any
  produced file or output.

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
- Merged the same morning (Oct 26): the stub verify-ts above
  was replaced by the W0 implementation in the entry below,
  per the pre-agreed reconciliation; the verifier bot and
  link preview stand as built, adapted to the core's export
  names (canonicalAttestationMessage). Narrative:
  docs/narrative/2026-10-26-first-build.md.
- Doc correction: docs/DESIGN.md's decisions summary no longer
  describes a canonical signing prefix (the D2 resolution
  adopted the W0 canonical form — the serialised payload
  alone is the message); the Oct 25 entry below carries the
  matching correction note.
## 2026-10-26: verify core and verify MCP implemented (W0)

- Decision (Oct 26, 2026): no project-run public HTTP instance
  of the verify MCP in v1 (W0 spec 11.9 M1, decided by Nic).
  Discovery is via the MCP registry listings; the HTTP transport
  ships for self-hosters only.

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
  demo signing wallet verifies against the real AgentBook contract,
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
