# Changes

## 2026-10-26: dynamic badge service (W0 SPEC section 4)

- badge-service/: the served badge from W0 SPEC section 4, as a
  top-level app (not a workspace package) over @fiador/verify
  through its public exports only. Plain Node HTTP; PNG via
  @resvg/resvg-js rasterising the served SVG at 3x. Routes:
  /badge/:subjectType/:subjectId.svg|.png (plus the legacy
  untyped alias), /v1/status/:subjectType/:subjectId returning
  the public projection plus the badge URL matrix (the verify
  MCP badge_status shape), /health, and the both-themes
  explainer at /.
- States verified/expired/unverified rendered from the canonical
  palette tables in assets/badges/, both themes and both
  variants; auto SVG composes both palettes via
  prefers-color-scheme, auto PNG resolves from the client hint
  with the dark fallback and X-Badge-Theme. Cache behaviour
  implements the SPEC 4.6 proposals as configuration (300s
  verified/expired, 60s negative, no-store on unknown,
  stale-on-error inside 900s with the original check time).
- Keyless and fetchless: the attestation source is a local
  registry file mapping type:id to a signed attestation (the
  verify MCP shape), loaded at startup; the service fetches
  nothing. That narrows SPEC 4.2"s URL-registry-plus-fetch
  sketch deliberately; the divergence and its rationale are
  recorded in badge-service/README.md.
- Suite: 27 route-level tests in badge-service (fake verifier
  and resolver, real HTTP on an ephemeral port), including the
  raw-humanId deep scan over every response. Nothing deployed;
  v1 operates no project-run public instance.

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
- The founding attestation was signed with the dedicated
  World Program wallet via tools/signer and live-verified at
  signing time: status verified, 2026-10-26T10:10:50Z,
  payload hash
  8bfeb9f9182de3ce63cdf42bdff941277250d96089982c65f0f97761f195a031,
  expires 2027-01-24. Narrative:
  docs/narrative/2026-10-26-founding-attestation.md.
- DESIGN §9 precondition synced: the program wallet's
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
