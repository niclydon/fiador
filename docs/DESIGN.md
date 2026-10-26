# W1 — Fiador — human-backed attestation for Discord bots: build-ready design

Status: DESIGN, 2026-10-25; revised the same day for the
first-repo decision, the settled queue decisions, the repo's
creation, and its rename to Fiador (all Oct 25, 2026).
Workstream W1 of the World Program.
Governing doc: `~/workspace/world-program/PORTFOLIO.md`
Source spec: `~/workspace/world-discord-attest/SPEC.md` (approved in shape, Nic, Oct 25, 2026)
Verify-package spec: `~/workspace/world-program/w0-verify-core/SPEC.md` (W0, Oct 25, 2026)
Consumer specs consulted for §4.7: `~/workspace/world-program/w2-approval-inbox/SPEC.md`,
`~/workspace/world-program/w3-provenance-seal/SPEC.md`,
`~/workspace/world-program/w4-callback-verified-ea/SPEC.md`
Visuals: `~/workspace/world-visual-assets/` (batch 1, approved "for now, for the public repo", Oct 25, 2026)
Seed code: AgentKit playground (private estate prototype, built and
live-tested Oct 24-25, 2026), `src/agentkit-core.ts`
(`createAgentBookVerifier().lookupHuman(address)` from `@worldcoin/agentkit`, `viem` for accounts)

Decision recorded Oct 25, 2026 (Nic, via the coordinator, and in
the portfolio Decisions log): W1 is the program's first repo, and
the W0 verify core is folded into this repo as a clearly separated
verify package — its own module boundary, designed for later
extraction. The portfolio log fixes the extraction trigger: W0
extracts into its own repo when a second project consumes it. The
W0 chat re-scopes to designing that package inside W1; §13 of this
design is the coordination surface between the two chats, and
divergences go through the coordinator, not around it.

This document turns the spec into a build plan a builder can start
from without re-deciding architecture. Naming history, because
the sections below were revised decision by decision: the repo
was first named `human-backed` (decided Oct 25, 2026, checked
free the same day), created public that evening as
`niclydon/human-backed` (founding commit ed7f840), and renamed
later the same day to Fiador — the Spanish/Portuguese legal word
for the guarantor who stands surety for another — repo renamed
on GitHub to `niclydon/fiador` and verified live from this seat;
`fiador.org`, npm `fiador`, and PyPI `fiador` all checked free
Oct 25, 2026. Fiador is the project name everywhere in this
design: repo, packages, commands, and badge branding.
"human-backed" survives as descriptive prose where it is plainly
generic (the claim the protocol makes, the Discord role label),
following the W1 spec's copy. The licence is Apache-2.0, the
program default; the credit model is a name stamp plus the
house visual style (§8.1). Repo creation is executed fact, not
a pending gate; commit plus push still needs Nic's go each time.

Program direction (Nic, Oct 25, 2026, "make it so throughout the
program"; full text in the portfolio): Fiador is the program's
first public project and its demo, and two of its directions
shape this design's framing — ship order (a demo-able Fiador
and a real presence in the official AgentBook registry outrank
polish, §12) and the no-token position (stated on purpose in
the project's public positioning, §7). A third direction, an
internal design constraint on API shape and evidentiary
outputs, is applied at §6.3 in the neutral terms the repo's
public-copy rules require. No protocol element changes for
any of the three.

Prerequisite status, checked 2026-10-25 evening: the wall the spec
called out in its test plan is cleared. Nic completed Orb
verification in New York on Oct 25, the playground wallet completed
AgentBook registration the same evening (live check: `registered:
true`, superseding `registered: false` at Oct 24 23:45 ET), and the
playground acceptance pass ran (granted on the free-trial calls,
denied 402 once the trial exhausted, `agentkit_status` and
`agentkit_self_test` passing). Public-facing copies of any of this
use truncated identifiers only, per the portfolio boundary in §10.
The full wallet address and humanId stay in the private estate
record, never in this design's public-repo descendants.

## 1. What this proves, and what it does not

Printed in the README in these words, not buried. Copied from the
spec's honest-limits section; the design adds no stronger claim.

- Proves: a unique human backs the operator's wallet registration
  in AgentBook on World Chain.
- Does not prove: the human wrote, read, or approved any given bot
  message; the bot's current runtime is the code the operator
  claims; or who the human is. World ID is anonymous by design:
  the proof says "a unique human", never who.
- Freshness: registration is checked live at verification time,
  but a granted Discord role is only as fresh as the verifier's
  last sync. Every surface that reports a result — library return,
  bot embed, verify page, served badge — carries `checkedAt`.
  The link preview (§6.4) is the weakest surface by construction:
  its card is a crawl-time snapshot inside a platform cache the
  project does not control, so it is labelled a snapshot wherever
  it is described, and the canonical-domain click-through check
  is the only form of it anyone is asked to trust.
- A stolen bot token still passes an old attestation. The
  attestation authenticates the operator's claim about an
  application ID, not the running process. Expiry (§3) bounds this,
  it does not eliminate it.

Threat model, short form (full version lands in the repo as
`docs/threat-model.md`, reviewed per portfolio quality bar 5):

- Copying an attestation: useless without the wallet key. The
  payload binds application ID to wallet, signed by that wallet;
  a copier cannot re-bind it to a different application ID, and
  pointing a verifier at the original still reports the original
  application's wallet and status.
- Copying a served badge: the badge URL names an application ID
  and renders that ID's live status (§6). Copying it to another
  bot advertises the original, it does not fake the copier's.
- Replay: an expired payload fails; a payload replayed inside its
  validity window for the same application ID is the attestation
  working as intended, not an attack. Cross-application replay
  fails the application-ID check. Cross-guild replay is intended:
  the attestation is per-application, not per-guild.
- Registry poisoning: registry entries are PR-reviewed (§3.4)
  and, more importantly, never trusted on their own. A registry
  entry only tells a verifier where to fetch; the signature and
  the live AgentBook read decide.
- Malicious attestation URL: SSRF and payload-bomb risk for any
  verifier that fetches operator-supplied URLs. Mitigations are
  mandatory for every fetching component, listed in §5.4.
- RPC lying or failing: a compromised or wrong-chain RPC can fake
  a registration read. Mitigations: pin chain ID 480, pin the
  AgentBook contract address, allow an operator-configured RPC
  plus a documented public default, and fail closed on RPC error
  (package result status `unknown`, failure `lookup_failed`,
  never a pass and never a false `unregistered`, §4.2).

## 2. Architecture at a glance

```
Operator                    Registry / hosting          Verifiers
--------                    ------------------          ---------

wallet key --signs--> attestation JSON --published at--> attestation_url
                             |                                 ^
                             +-- indexed by app ID in --------+
                                 registry.json                  |
                                                               | fetch + verify
Discord application ID ----------------------------------------+---- verify package (TS / Python)
                                                               |---- static verify page (browser)
Guild guild + verifier bot --- /attest, /verify-agent --------+---- role grant / revoke + sync loop
                                                               |
World Chain (eip155:480)                                       |
  AgentBook 0xA23a...44dA -- lookupHuman(wallet) -------------+  live read at every verify
```

Three parties, three jobs, per the spec. No party runs another
party's code:

- Operator attests and publishes. Near-zero change to their bot.
- Verifier checks: signature, expiry, live AgentBook read.
- Guild enforces: runs its own verifier instance (§5,
  self-host, decided), owns the "Human-backed" role and its
  policy. The guild never reviews operator code.

Components built by this workstream:

1. The verify package (§4) — the folded-in W0 verify core. A
   first-class deliverable of this repo, not an internal helper:
   it carries W0's spec, its own API, tests, versioning, and
   extraction boundary, and W1 is only its first consumer.
2. Attestation format + registry (§3) — the Discord profile of
   the package's generic attestation (§3.1), plus the registry
   only W1 needs.
3. Reference verifier bot (§5) — a consumer of the package.
4. Static verify page, plus the dynamic served-badge service
   (§6) — consumers of the package; the badge service is W0's
   second deliverable, housed in this repo on the same terms.
5. Examples, README, and narrative (§7, repo layout in §8)

A third consumption surface is specced by W0 (approved by Nic
Oct 25, 2026; W0 owns its spec, relayed to this workstream when
it lands): a public verify MCP server — a thin MCP wrapper over
the verify core exposing wallet lookup, attestation
verification, and badge status, with no semantics of its own.
From this design's side, the standing facts are: it is a
consumer like the bot (§5) and the page (§6.1), reading the
same core results and the same public-safe projection (the
§6.3 result shape; hash-only, per §3.3 — the core's private
`includeRawHumanId` mode is not reachable through it), and it
inherits the package boundary unchanged (arrows still point
into the package only). No W1 surface work is owed for it until
W0's section lands; the demo and registry sequencing in §12
already accounts for it there.

Dependency rule that keeps the fold honest: arrows point into
the package, never out of it. The package imports nothing from
the bot, the page, the badge service, the registry code, or any
Discord type. Everything else in the repo may import the package.

Explicit non-goals for v1: no code inside muse-discord (an adapter
is a v2 example), no hosted verifier of any kind — v1 ships
self-host only, plus the static verify page (decided Oct 25,
2026; a hosted instance is a possible v2 addition, §5) — no
World product or endorsement claim, no World marks in the
project or repo name, no message-authorship proof.

## 3. Component 2 — Attestation format and registry

### 3.1 Canonical attestation payload (v1)

The Discord attestation is a profile of the verify package's
generic attestation (W0 spec §3.2), not a second format. On the
wire a published attestation is a `SignedAttestation`:
`{ payload: AttestationPayloadV1, signature, signatureType }`,
where the payload's subject is
`{ type: 'discord_application', id: <discord_application_id> }`
and Discord-specific signed fields ride in the payload's `extra`
record, which the core validates as signed-but-not-interpreted
and this profile interprets. The table below is the profile's
logical field list; the mapping after it is normative.

JSON object, UTF-8, signed as in §3.2. Field order in the file is
not significant; the signed form is canonicalised, see §3.2.

| Field | Type | Rules |
|---|---|---|
| `version` | integer | `1`. Unknown versions fail with `UNSUPPORTED_VERSION`. |
| `discord_application_id` | string, decimal snowflake | The identity being attested. Stable across guilds. Primary key everywhere. |
| `discord_bot_user_id` | string, decimal snowflake | The bot user, distinct from the application ID. Verifiers cross-check where Discord makes this available; mismatch is a failure, not a warning. |
| `agent_wallet_address` | string, `0x` + 40 hex | EIP-55 checksummed in display; comparison is case-insensitive after checksum validation. Signature must recover to this address. |
| `operator_display_name` | string, OPTIONAL, max 64 chars | The operator's display name, off by default (§3.1.1): the field is simply absent unless the operator opts in. Self-asserted — the signature covers it like every payload field, so it cannot be altered after signing without invalidating the attestation, but nothing verifies it against any identity. Verifiers display it only when present, labelled self-asserted. No verifier, registry, or guild may require it. |
| `human_id_hash` | string, 64 hex chars (no `0x` prefix in the hash's canonical form, §3.3) | REQUIRED in a public Discord attestation (decided Oct 25, 2026: hash only, §3.3). The hash of the operator's humanId under the construction in §3.3, computed by the operator from their own registration (they can read it from their own wallet's AgentBook entry). There is no field for the full humanId anywhere in this format, at any disclosure setting. A payload missing the hash fails profile validation; a payload carrying a raw humanId field fails as an unknown/malformed profile field — it is rejected, never republished or logged by a verifier. |
| `human_id_disclosure` | enum, pinned: `hash` | The generic payload's disclosure field, pinned to `hash` by this profile (decided Oct 25, 2026). Any other value (`raw`, `none`) is a profile validation failure for a public Discord attestation. The generic core still defines the wider enum for other consumers' private contexts; this profile does not use the wider range, and there is no operator election to widen it. |
| `attestation_url` | string, HTTPS URL | Where this payload is hosted. Self-referential on purpose: a fetched payload whose `attestation_url` does not match the URL it was fetched from fails with `URL_MISMATCH`, except in the paste / `/attest` flows where there is no fetch URL (then the field is informational). |
| `issued_at` | string, RFC 3339 UTC | Must not be more than 5 minutes in the future at verify time (clock-skew allowance). |
| `expires_at` | string, RFC 3339 UTC | Hard cap: `issued_at + 90 days`. Longer windows are clamped by failure, not silently accepted: `EXPIRY_TOO_LONG`. Re-signing is the renewal mechanism; there is no refresh token. |
| `nonce` | string, 16-64 chars, `[A-Za-z0-9_-]` | Operator-generated, unique per signing. Makes two otherwise identical attestations distinct and gives revocation discussions a handle. No server-issued nonce in v1 (no server). |
| `signature` | string, `0x` + 130 hex | EIP-191 `personal_sign` over the canonical signing string, §3.2. |

Mapping to the generic payload (normative): `version` →
`payload.version`; `discord_application_id` →
`payload.subject.id` (with `subject.type` fixed above);
`discord_bot_user_id` → `payload.extra.discord_bot_user_id`;
`agent_wallet_address` → `payload.agentWalletAddress`;
`operator_display_name` → `payload.operatorDisplayName`;
`human_id_disclosure` → `payload.humanIdDisclosure` (pinned
to `hash`, above);
`human_id_hash` (required) → `payload.extra.human_id_hash`;
`attestation_url` → `payload.attestationUrl`; `issued_at` →
`payload.issuedAt`; `expires_at` → `payload.expiresAt`; `nonce`
→ `payload.nonce`; `signature` → the envelope's `signature`,
with `signatureType` `eip191` for an EOA wallet or `eip1271`
for a smart wallet (W0 spec §3.2). Failure-code names in the
table above are this profile's shorthand; the codes the package
returns are the snake_case union in §4.2, and the profile maps
onto them one-to-one (for example `EXPIRY_TOO_LONG` is the core's
`malformed_attestation` on the over-90-day rule, `URL_MISMATCH`
and `HUMAN_HASH_MISMATCH` are profile-level checks the Discord
layer performs on top of a core result, in §4.6).

#### 3.1.1 Operator display name — optional, off by default

Decided Oct 25, 2026 (Nic, via the coordinator). The protocol
default is name-free: an attestation needs no name in it, most
will have none, and no operator is ever required to name
themselves — not by the format, not by the registry, not by a
guild as a condition of the role. The field exists for
operators who are already public under their name and prefer
the attestation to say so. Semantics:

- Absence is the default state, not missing data. A payload
  without `operator_display_name` is complete; verifiers render
  nothing in its place — no placeholder, no "anonymous
  operator" label, no inference from the Discord application's
  name or the wallet's history.
- When present, the name is self-asserted by the operator's
  signature, exactly like the rest of the payload: the
  canonical signing string (§3.2) includes the field (empty
  when absent), so editing the name after signing invalidates
  the signature — the §9 tamper test edits this very field.
  That is all the signature proves: the wallet holder asserted
  this name at signing time. It does not prove the name is
  theirs in any legal or World sense, and no surface may
  present it as verified identity — surfaces that show it label
  it self-asserted, or show it in a context that already says
  so (§§5.3, 6.1). Anyone can sign any name with their own
  wallet; the field is a claim, displayed as one.
- Verifiers display it only when present. That rule has no
  config override on the verifier side: a verifier may not
  suppress a present name or invent an absent one, because both
  would misrepresent what the operator signed.
- The registry does not carry it (discovery data is application
  ID + URL, §3.4); the name is read from the payload at verify
  time, so an operator who re-signs without it disappears from
  display at the next check, with no registry edit to chase.
- The signer CLI omits it unless the operator explicitly opts
  in (a flag, never a prompt that nudges), and the walkthrough
  presents it as optional in those words.
- Nic's own fleet opts in: his bots already operate publicly
  as his, so Nova's attestation (§9 step 1) carries
  `operator_display_name: "Nic Lydon"`. That is one operator's
  election under this rule, recorded so the test fixtures and
  the demo read consistently — it sets no expectation for any
  other operator, and the demo copy says so.

Two JSON Schemas ship: the generic attestation schema inside
the verify package (its own file, its own tests), and the
Discord profile schema in `registry/attestation.schema.json`,
which validates the generic envelope plus this profile's
`subject.type` and `extra` requirements. The Python port
validates against copies of both; a parity test asserts the
copies are byte-identical to the package's.

### 3.2 Signing and canonicalisation

The single most interop-sensitive part of the protocol. Both
libraries and all fixtures follow exactly this:

1. Take the generic payload object (§3.1 mapping); the signature
   lives in the envelope, outside the payload, so nothing is
   stripped.
2. Serialise with the package's canonical form (W0 spec §3.2):
   keys in the exact payload order (subject, wallet, URL, name,
   disclosure, dates, nonce), `extra` keys sorted
   lexicographically, no insignificant whitespace, addresses
   EIP-55 checksummed, timestamps UTC ISO 8601 with `Z`. That
   deterministic string, and nothing else, is the message. It is
   produced by the package's exported
   `canonicalAttestationMessage(payload)` so every workstream's
   signer and verifier work on identical bytes.
   First-revision note: this design originally specified sorted
   keys throughout (an RFC 8785 subset) plus a
   `fiador-discord-attestation:v1\n` domain prefix. The W0
   spec's ordered-keys form is adopted instead, because the
   package owns canonicalisation and two canonical forms for one
   payload would guarantee interop failure; the divergence and
   its resolution are logged in §13 (D2). Domain separation is
   not lost: the subject type is inside the signed payload, so a
   Discord attestation cannot be replayed as another subject's,
   and other protocols (W3's seal, §4.7) keep their own prefixes
   on their own payloads, outside this one.
3. Sign with EIP-191 `personal_sign` over the canonical string
   for an EOA wallet; a smart-wallet operator signs the same
   string and declares `signatureType: 'eip1271'`. Verification
   uses `viem` `verifyMessage`, which handles both (W0 spec
   §3.2). Python parity: `eth-account` recovery for EIP-191;
   EIP-1271 in Python requires a contract read and is a named
   parity exception until the port implements it, recorded in
   the package's parity notes rather than silently weaker. The
   playground seed already uses `viem` accounts and
   `@worldcoin/agentkit`, so the TS package stays on `viem` to
   inherit a proven path.
5. Reference signer: a small CLI in `tools/` (TS) that takes a
   payload draft and a wallet key from an environment variable
   (never an argument, never logged — same discipline as the
   playground's `agentkit-core.ts`, which reads its key from `.env`
   and never returns or logs it), prints the complete signed
   attestation JSON, and nothing else. The walkthrough in
   `examples/publish-your-attestation/` drives it. Under the
   HUMANID RULE (§3.3), the CLI derives `human_id_hash` itself:
   it resolves the operator's own registration from their wallet
   address, hashes the value in-process, and never prints, logs,
   or writes the full humanId anywhere — and it never asks the
   operator to paste it. A signer that needs the humanId typed
   into it would put the value in shell history and terminal
   scrollback; the CLI is designed so the value never transits
   either.

### 3.3 humanId handling — hash only in public, settled

This is THE HUMANID RULE (Nic-direct, Oct 25, 2026), the
program's binding privacy rule: the full humanId is never
published anywhere outside the estate — no repo, post, page,
fixture, screenshot, log, or outward message — and public
material carries a hash of it only. It is written into the
portfolio (boundary section, as THE HUMANID RULE), into
`~/AGENTS.md` as a standing convention binding every agent,
and into the W1 spec (verification step and decisions section:
hash only, settled, no v1 override). This section is the
format-level settlement in this design; §10's launch checklist
enforces it mechanically, and the leak-path audit at the end
of this section is the checklist's map.

- Where the full value lives: only in two private places — the
  AgentBook contract itself, and a verifier's process memory
  for the duration of one check. A verifier resolves the full
  value privately, at check time, by calling
  `lookupHuman(agent_wallet_address)` on World Chain from the
  wallet address in the payload. That is the only resolution
  path; no public artifact is ever a source of the full value,
  and no verifier persists, logs, displays, or returns it.
- The hash construction the format specifies (normative; the
  package's exported `hashHumanId` implements exactly this,
  W0 spec §3.5): take the humanId in its canonical text form —
  the `0x`-prefixed, lowercase, 64-hex-character string
  `lookupHuman` returns, normalised to lowercase — concatenate
  the literal ASCII prefix `w0-human-v1:` in front of it, take
  SHA-256 over the UTF-8 bytes of the resulting string, and
  encode the digest as 64 lowercase hex characters, with no
  `0x` prefix. In one line:
  `humanHash = hex( sha256( utf8( "w0-human-v1:" + humanId ) ) )`.
  The domain-separation prefix is part of the construction, so
  the hash is not a bare hash of a World identifier reusable
  across unrelated systems, and fixture vectors (§4.4) pin this
  byte-for-byte so the TS and Python implementations cannot
  drift on case, prefix, or encoding. First-revision note: this
  design originally specified `keccak256(humanId bytes)`; the
  W0 algorithm is adopted so there is exactly one human-hash
  in the program (§13, D1).
- What the payload carries: `extra.human_id_hash` (§3.1),
  required, holding exactly that construction's output. The
  operator computes it from their own registration when signing.
  The verifier never trusts the payload's copy: it recomputes
  the hash from the live lookup and compares. Mismatch is the
  profile-level failure `HUMAN_HASH_MISMATCH` (payload is stale,
  or the wallet's registration changed hands / entries since
  signing). Purpose of publishing the hash at all, unchanged:
  a guild can see "these two bots trace to the same human"
  without the raw humanId crossing any surface.
- What other public material carries: registry entries carry
  no humanId in any form (neither raw nor hashed — the registry
  is discovery data: application ID and URL only, §3.4); the
  served badge carries no identifier beyond the application ID
  in its URL (§6.3, W0 spec §4.3); the badge service's JSON
  status route and the verify page surface `humanHash` only
  (truncated in display, §5.3); bot logs and `check_log` store
  the hash, never the value (§5.1). Screenshots for
  verification evidence are taken of surfaces that have no
  full value to show, which is the point of designing it this
  way rather than redacting afterwards.
- Fixtures: attestation fixtures carry the hash only, like real
  payloads. Lookups in tests resolve through fake readers whose
  humanId-shaped return values are synthetic sentinels generated
  for the tests, labelled synthetic in the fixture README, and
  belonging to no person (W0 spec §7.1) — the rule this decision
  settles is that no real person's full humanId enters a fixture
  or any other public file, and §10's scan checks the tree for
  humanId-shaped values that are not hashes or synthetic
  sentinels.
- The one private exception, fenced: the package's
  `includeRawHumanId` mode (W0 spec §3.5) exists for the
  operator's own private tooling over their own wallet (the
  playground MCP pattern), inside the estate. It is never
  enabled by any public surface, its output is private-zone
  material under the portfolio boundary, and it plays no part
  in the public attestation format — a payload has no raw form
  for it to produce.
- Leak-path audit (run over this design Oct 25, 2026, when the
  rule landed; re-run at §10 time against the built tree).
  Every place the full value could escape, and its control:

  | Surface | Leak path | Control in this design |
  |---|---|---|
  | Attestation payloads | A raw field in the format | No such field exists (§3.1); a payload carrying one is rejected as malformed, never republished or logged |
  | Registry entries | A humanId or hash copied into discovery data | Registry schema has no humanId field in any form (§3.4); the CI registry self-check rejects unknown fields |
  | Example payloads | The walkthrough's sample payload using a real registration | Sample uses a synthetic sentinel's hash, labelled synthetic (§3.3 fixtures rule applies to examples) |
  | Signer flow | Operator pasting the value; CLI echoing it | The CLI derives the hash in-process from the wallet's registration and never prints the value (§3.2 item 5); the walkthrough never asks for it |
  | Fixtures | Real registrations recorded as test vectors | Hash only in attestation fixtures; fake-reader values are labelled synthetic sentinels (§4.4); §10 scan enforces |
  | Verifier internals | The resolved value reaching logs, errors, or storage | Value lives in process memory for one check only (§3.3); `check_log` stores the hash; failure details and exceptions carry codes, never values — a package test deep-scans result serialisations for it (§4.4) |
  | Bot log channel | Grant/revoke lines quoting check output | Lines carry status + hash truncated, the same field set as the embeds (§5.3) |
  | Badge + verify page | Identifier in a URL, query, or rendered field | Routes key on application ID only (§6.3); page inputs are wallet / app / URL; results render `humanHash` truncated; the value is never a URL component anywhere |
  | Screenshots | Evidence shots of a surface showing the value | Public surfaces have no full value to show by construction; §9/§10 screenshots are of those surfaces |
  | Verification evidence | `docs/verification.md` quoting a live lookup | Entries record status, wallet truncated, and hash truncated — the doc's entry format is specified that way (§9) |
  | CI output | A failing test printing a live result | Package results contain no raw value to print (default mode, §4.3); live-chain tests run behind a flag with the same outputs |
  | Git history | A value committed early, deleted later | §10's scan runs over full history, and its humanId pattern check is part of that pass, not only the tree |
  | Outward messages | A post or showcase quoting a check | §10's outward-post gate (Nic approves exact text) plus the rule itself, which binds messages as much as files |

  Paths considered and found already closed in the earlier
  drafts: bot DMs (the bot never DMs, §5.2), analytics (the page
  ships none, §6.1), third-party embeds in examples (none).
- W4 deliberately does not display even a human hash (§4.7);
  that is a display choice within this settlement, not an
  exception to it — where a hash is shown anywhere in the
  program, it is this construction's output.

### 3.4 Registry

- Location: `registry/registry.json` in the public repo for v1.
  A hosted copy is a byte-for-byte mirror of the repo file served
  over HTTPS (static hosting is sufficient); the repo file is
  canonical. If the registry host and the repo disagree, verifiers
  treat the fetched copy's `generated_at` as informational only —
  trust comes from the per-entry checks, never from the registry.
- Format: `{ "version": 1, "generated_at": "<RFC3339>",
  "entries": [ Entry ] }` where Entry is
  `{ "discord_application_id": "...", "attestation_url": "https://...",
     "submitted_by": "<free text, e.g. a GitHub handle>",
     "added_at": "<RFC3339>" }`.
  One entry per application ID. Sorted by application ID so diffs
  are reviewable. Entries carry no humanId in any form (§3.3).
  Two additions serve the link preview (§6.4): the registry
  index the preview resolves against is derived from entry
  payload hashes (computed at publish time from the fetched
  attestation, never a second hand-maintained file), and an
  operator may mark an entry `"status": "revoked"` instead of
  deleting it — a tombstone that keeps old `/v/` links
  rendering an honest revoked card. Deletion remains possible;
  tombstoning is the recommended removal path, and
  `registry/CONTRIBUTING.md` says so.
- Schema ships as `registry/registry.schema.json`; CI validates
  every PR against it, plus: HTTPS-only URLs, no duplicate
  application IDs, and a live fetch-and-verify of the submitted
  attestation in CI (a registry PR that does not verify at merge
  time does not merge; expiry after merge is normal lifecycle,
  handled by verifier sync, not by registry edits).
- Contribution rules (`registry/CONTRIBUTING.md` in repo): PR by
  the operator or anyone on their behalf; the PR description must
  state the bot name for human reviewers; removal is by PR from
  anyone, merged on a failed verify plus a 7-day issue notice, or
  immediately on the operator's own PR. No maintainer discretion
  about who "deserves" listing: verifies + schema-valid = listed.
- Revocation: there is no push revocation channel in v1. The
  mechanisms are expiry (max 90 days), registry removal (stops
  discovery, not guild-local bindings), and guild-local removal by
  the verifier's sync loop when a check fails. The spec text says
  this plainly so nobody designs around a revocation API that
  does not exist.

### 3.5 Discovery flows

1. Registry lookup: verifier has an application ID, looks it up
   in a registry copy, fetches `attestation_url`, verifies.
2. Install-time claim: operator runs `/attest` in a guild (§5)
   with a URL or a pasted payload. The verifier verifies, stores
   the binding guild-locally (`application_id -> attestation_url`
   plus the payload hash), and thereafter syncs from the URL.
   Works for unlisted bots; never writes to the public registry.

## 4. Component 1 — The verify package (W0 folded in)

### 4.0 Package status and boundary

The verify package is a first-class deliverable of the W1 repo,
specified by the W0 spec and housed here by the Oct 25, 2026
first-repo decision. It is not W1's internal helper, and it is
designed from the start against consumers beyond W1 (§4.7).

Boundary, enforceable in CI, not just stated:

- Location: `packages/verify-ts/` (lead implementation, per the
  W0 spec: TypeScript first, ESM, Node 20+) and
  `packages/verify-py/` (the parity port, §4.5). The package is
  the pair plus their shared fixtures; the fixtures live inside
  the package directory so the unit that extracts is
  self-contained.
- The package exports a closed surface (§4.1 helpers included;
  the W0 spec's rule stands: no other exports in v1). It has its
  own README, its own CHANGELOG, and its own semantic version,
  independent of the repo's other components. A breaking API
  change is a major version bump even while the package is
  unpublished and in-repo, so consumers pin against something
  real from day one.
- Forbidden imports, checked by a lint rule in CI: no Discord
  types or libraries, no Hono/Express/MCP types, no imports from
  sibling components (`verifier-bot/`, `verify-page/`,
  `badge-service/`, `registry/` tooling), no environment-variable
  reads, and no private-key material of any kind — there is no
  option or flag that makes the package read a key (W0 spec §3).
  All network access goes through the injectable `AgentBookReader`
  (§4.3), so the core runs offline against fixtures and runs
  client-side in a browser (the W1 verify page and the W3 verify
  page both depend on that).
- Subject knowledge is generic only: addresses, typed subjects
  (`{ type, id }`), attestations, statuses. What a Discord
  application ID is, what a content hash is, what a Cole task is
  — semantics belong to the consumers, which validate their own
  subject types and their `extra` fields after the package
  returns (§3.1).
- Extraction path (§4.8): the package is built and tested as if
  it already lived alone; extraction on the portfolio trigger is
  a move, not a refactor.

### 4.1 Core API (adopted from the W0 spec §3)

```ts
export type EvmAddress = `0x${string}`

export type VerificationStatus =
  | 'verified'      // checked live: registration (and attestation, if any) valid
  | 'unregistered'  // checked live: no AgentBook entry for the address
  | 'expired'       // attestation exists but is past expiresAt
  | 'invalid'       // attestation malformed, mis-signed, or mis-bound
  | 'unknown'       // the check itself failed (RPC, network, timeout)

export interface VerifyResult {
  status: VerificationStatus,
  address: EvmAddress,            // checksummed, as checked
  addressTruncated: string,       // '0x7d7D…6097f' form, safe for public output
  humanHash: string | null,       // §3.3; null unless status is 'verified'
  failures: FailureCode[],        // §4.2; empty iff status is 'verified'
  evidence: {
    checkedAt: string,            // ISO 8601, when the live check ran
    source: 'live' | 'cache' | 'fixture',
    agentBook: { network: 'eip155:480', contract: EvmAddress },
    rpcLatencyMs?: number,
  },
}

export interface VerifyCoreOptions {
  reader?: AgentBookReader,       // §4.3; default SDK-backed
  rpcUrl?: string,                // World Chain RPC; documented public default
  contractAddress?: EvmAddress,   // default: canonical AgentBook
  timeoutMs?: number,             // per-lookup deadline, default 5000
  now?: () => Date,               // test injection
  clockSkewMs?: number,           // default 60_000
  includeRawHumanId?: boolean,    // default false; private tooling only, §3.3
}

export function createVerifier(options?: VerifyCoreOptions): Verifier

export interface Verifier {
  verifyAddress(address: string, opts?): Promise<VerifyResult>
  verifyAttestation(attestation: unknown, opts?: {
    expectedSubject?: { type: string, id: string },
    expectedWallet?: EvmAddress,
    nonceStore?: NonceStore,      // optional; stateless without one, §4.2 step 5
    checkRegistration?: boolean,  // default true
  }): Promise<VerifyResult>
  resolveStatus(subject: StatusSubject, opts?): Promise<VerifyResult>
}

export type StatusSubject =
  | { kind: 'address', address: string }
  | { kind: 'attestation', attestation: SignedAttestation }
  | { kind: 'attested_subject', subject: { type: string, id: string },
      resolveAttestation: (subject) => Promise<SignedAttestation | null> }
```

Helpers, the rest of the closed surface: `truncateAddress`,
`hashHumanId`, `canonicalAttestationMessage`,
`isVerificationStatus`. Plus one generic primitive the consumer
specs require (§4.7): signature verification over an arbitrary
caller-canonicalised message (`verifySignedMessage({ message,
signature, signatureType, expectedAddress })`), so a consumer
with its own payload format (W3's seal) uses the package's
recovery/1271 path instead of re-implementing it. Adding this
export is a divergence from the W0 spec's "no other exports"
list, proposed here for coordinator/W0 agreement (§13, D5) —
the alternative is every consumer hand-rolling the most
security-sensitive check in the system.

Rules for every function (W0 spec §3.0, binding): the library
never throws for an expected failure — bad input, unregistered
wallet, dead RPC all return a result; no error path returns
`verified`; addresses are validated and checksummed on entry;
no raw humanId leaves the result unless `includeRawHumanId` was
explicitly set by a private caller.

The Discord layer (§4.6) sits outside the package's core
surface, as a `discord` subpath export of the TS package
(`verify-ts/discord`) and a `discord` submodule of the Python
package: it owns §3's profile, the registry/URL resolution, and
the mapping of a core `VerifyResult` plus profile checks into
the bot/page result shape. It may import the core; the core may
never import it. On extraction, the core moves; whether the
Discord subpath moves with it or stays in the W1 repo as a
consumer-side adapter is an extraction-time decision (§4.8),
and the subpath boundary is what makes either answer cheap.

Python (`packages/verify-py`) mirrors the core field-for-field
with snake_case names (`create_verifier(...) -> Verifier` with
`verify_address` / `verify_attestation` / `resolve_status`, a
`VerifyResult` dataclass). A cross-language conformance test
runs the same fixture set through both and diffs the normalised
results; a field rename in one without the other fails CI.

### 4.2 Verification steps and failure codes (core)

`verifyAttestation`, checks in order (W0 spec §3.3); the headline
status follows the W0 precedence — `invalid` outranks `expired`,
which outranks `unregistered`; `unknown` outranks `verified`
and `unregistered` but not `invalid` or `expired`, which are
established from the payload alone:

1. Shape: payload parses, `version` supported, required fields
   well-formed → else `invalid` + `malformed_attestation` (or
   `unsupported_version`).
2. Binding: `expectedSubject` / `expectedWallet`, when supplied,
   must equal the payload's → else `invalid` + `subject_mismatch`
   / `wallet_mismatch`. This is what stops an attestation for
   one bot being presented for another.
3. Signature: EIP-191 recovery or ERC-1271 validation (§3.2)
   over the canonical form must recover to
   `agentWalletAddress` → else `invalid` + `signature_mismatch`
   (the wrong-signer test case; a tampered payload fails here
   too, including tampering with any `extra` field, because
   `extra` is inside the signature).
4. Dates, against the injectable clock with the configured skew:
   `issuedAt` in the future beyond skew → `not_yet_valid`;
   `expiresAt` past → status `expired` + `expired`; lifetime
   over 90 days → `malformed_attestation` (the cap is protocol,
   not advice).
5. Replay: only when the caller supplies a `nonceStore`, a nonce
   already seen for this wallet → `invalid` + `replay_detected`,
   and a successful verification records the nonce until expiry.
   Without a store, verification is stateless and replay inside
   the window is bounded by step 2's subject binding and step
   4's expiry; the surfaces that need stronger (§5's bot, which
   does supply a store backed by its `binding` table) get it.
6. Registration (unless `checkRegistration: false`): the
   `verifyAddress` logic on `agentWalletAddress`. A resolved
   null humanId → `unregistered` + `not_registered`, even with a
   good signature. A transport failure or timeout → `unknown` +
   `lookup_failed` / `lookup_timeout`, never `unregistered` —
   the separation the W0 spec §2 calls out as the playground's
   sharp edge, and the distinction W4's page requires (§4.7).

Failure codes are the W0 spec §3.0 closed union, identical in
both languages: `malformed_address`, `malformed_attestation`,
`unsupported_version`, `signature_mismatch`, `subject_mismatch`,
`wallet_mismatch`, `not_yet_valid`, `expired`, `not_registered`,
`replay_detected`, `lookup_failed`, `lookup_timeout`. One
addition is pending coordinator decision (§13, D4): the W0 spec
proposes `attestation_not_found` for `resolveStatus` when a
subject resolver returns null — no attestation published is not
the same fact as an attestation checked and failed, and §5's bot
and §6's badge both render the difference. Each code maps to one
plain-language sentence in a shared `failure-messages.json`,
consumed by bot, page, and badge service, so wording cannot
drift. Resolution failures that happen before the package is
involved (registry miss, attestation fetch failure under §5.4's
guards, the Discord profile checks in §3.1) are the Discord
layer's codes, kept in the same file and the same style, and
never conflated with core codes of similar name.

### 4.3 Chain read

- Network: World Chain, `eip155:480`. Contract: AgentBook
  `0xA23aB2712eA7BBa896930544C7d6636a96b944dA`. Function:
  `lookupHuman(address) -> bytes32` (zero bytes = unregistered,
  normalised to null). All three figures are from the Oct 24, 2026
  playground work and are re-verified against current World docs
  as build step 1 (§12); the re-verification result is recorded in
  the repo narrative, per portfolio quality bar 4.
- TS readers sit behind the `AgentBookReader` interface (W0 spec
  §3.1), whose contract is the load-bearing detail: it returns
  the raw humanId for the core's internal use, returns null only
  when the contract read succeeded and there is no entry, and
  MUST throw on transport/RPC failure so the core can answer
  `unknown` instead of misreporting `unregistered`. Default
  reader wraps `@worldcoin/agentkit`
  `createAgentBookVerifier().lookupHuman(...)` — the playground's
  proven path, with injectable viem `PublicClient`, contract
  address, and RPC URL. Named build task, not a production
  discovery (W0 spec §3.1): prove by test whether the SDK ever
  swallows an RPC error into a null; if it does in any path, the
  default reader bypasses it for the read with a direct `viem`
  `readContract` against the same contract and ABI rather than
  inheriting the ambiguity. The alternate reader ships either
  way, and a test asserts both agree on the live fixture wallet.
  Python uses a direct JSON-RPC `eth_call` (transport injected)
  with the same ABI and the same throw-on-transport contract —
  no `web3.py` dependency for one call; signature recovery is
  the main crypto dependency (`eth-account`).
- The library never ships an RPC API key and never defaults to a
  keyed endpoint. Default is a documented public World Chain RPC;
  every production surface (bot, page) exposes an override.

### 4.4 Fixtures and tests (portfolio quality bar 3)

- `packages/verify-ts/fixtures/` (mirrored for the Python port,
  with a generator script that regenerates all vectors
  deterministically — fixed nonces and timestamps — and a CI
  check that committed vectors match a fresh generation, per
  the W0 spec §7.1): recorded payloads + recorded chain
  responses for — valid; expired; wrong signer; unregistered
  wallet; subject mismatch (the cross-bot replay case);
  schema-broken; plus the canonicalisation vectors (payload ->
  canonical bytes -> expected result) that pin §3.2 across
  languages, and the W0 spec §7.2 named tests verbatim as the
  package test list (RPC-failure-is-not-unregistered is a named
  regression test; the deep-scan assertion that a default
  `VerifyResult` serialisation contains no raw humanId anywhere
  is another). Discord-profile fixtures (bot-user mismatch,
  human-hash mismatch) live with the Discord layer's tests, not
  the core's, keeping the extraction unit clean.
- Fixture humanIds and wallets are synthetic (generated for the
  fixtures, keys published in the fixture README precisely because
  they control nothing and hold nothing) or, where a real
  registration is unavoidable, the dedicated demo wallet with
  truncated identifiers in every human-readable file. Under the
  hash-only settlement (§3.3): attestation fixtures carry the
  hash only, and no real person's full humanId appears in any
  fixture — the humanId-shaped values a fake reader returns are
  synthetic sentinels, labelled as such in the fixture README.
- Live-chain tests exist behind an explicit flag (TS:
  `LIVE_CHAIN_TEST=1`; Python: `--live` / env equivalent), never
  run by default in CI, and their last run with date + result is
  recorded in `docs/verification.md` (quality bar 6: "proven" is a
  state with a date).

### 4.5 Packaging and versioning

- TS: ESM, Node 20+ (per the W0 spec; this design's first
  revision said 18, the package spec wins, §13 D3), framework-
  agnostic, types shipped, no build step beyond `tsc`. Runtime
  dependencies are the SDK (`@worldcoin/agentkit`, for the
  default reader only — the reader is replaceable precisely so
  the dependency is) and `viem`. Working name `verify-core` is a
  folder/spec name only; the published package names derive
  from the project name `fiador` (decided, §11) and are
  settled at publish time — publishing to npm is a launch act,
  not a build act, and is gated in §10.
- Python: Python >= 3.11, `pyproject.toml`, typed, runtime
  dependencies kept to `eth-account` (+ its transitive hashing)
  and a transport the caller injects. The W0 spec leaves the
  Python port's ownership open (its Q7: a W0 item or a W1 one);
  this design houses the port in the W1 repo's package set,
  because the W1 spec lists `verify-py` as a repo deliverable,
  and flags the assignment for coordinator confirmation with
  the W0 chat (§13, D6). Same naming placeholder rule for PyPI.
- Versioning: the package pair versions together under one
  semver (a release is the TS package, the Python port, and the
  fixture set that proves they agree). Protocol changes that
  alter the canonical form or the payload bump the attestation
  `version`, not just the package version — the two version axes
  are distinct and both documented in the package README.

### 4.6 The Discord layer (W1's own, outside the core)

What W1 adds on top of the package, all in the `discord`
subpath/submodule and the bot/page code, never in the core:

- Input resolution: application ID → registry entry →
  attestation URL → guarded fetch (§5.4) → `SignedAttestation`;
  or URL / pasted payload directly. The resolver is exactly the
  `resolveAttestation` callback `resolveStatus` expects for
  `attested_subject` subjects, so the core composition does the
  verification and the layer does only Discord I/O.
- Profile checks from §3.1: `subject.type` is
  `discord_application`, `extra.discord_bot_user_id` matches the
  bot user Discord reports where available, `attestationUrl`
  matches the fetch URL where one exists, and
  `extra.human_id_hash` matches the live hash (§3.3).
- Presentation mapping: core `status` → the guild decision
  (grant only on `verified`; §5.5 owns the revoke asymmetries)
  and → the embed/page wording via `failure-messages.json`.
  The one simplification consumers outside Discord may use:
  `valid` means exactly `status === 'verified'`; nothing else
  is a pass, and `unknown` is never rendered as a negative
  finding about the wallet, only as a check that did not happen.

### 4.7 Designed against W2, W3, and W4 as future consumers

The package API above was checked line by line against the
three other Wave 1 specs. What each consumer needs, and where
the package answers it:

- W2, presence approval inbox. Its AgentBook surface is thin by
  its own design: requesting agents (Nova, ARIA) may be
  identified by an AgentBook-registered wallet (W2 spec §1.3),
  and W2 composes — it does not merge — an AgentBook result
  with its IDKit Proof of Presence result (W0 spec §5 states
  the same rule from the other side: W0's types grow no presence
  field in v1). Package answers: `verifyAddress` for the
  requesting-agent wallet, and a `VerifyResult` that is a plain
  serialisable value a composition can carry. Package explicitly
  does not answer: session proofs, `session_id` /
  `session_nullifier` handling, action-hash binding — those are
  W2's, and any pressure to grow them into the package is a
  divergence to route through the coordinator (§13), because a
  verify package that absorbs IDKit stops being the small thing
  W3 and W4 can also trust. W2's canonical action-hash pattern
  and this package's canonical attestation form are parallel
  instances of one program discipline (deterministic bytes, hash
  the exact payload), not a shared function, and the design
  keeps them that way deliberately.
- W3, provenance seal. Needs, in its spec's own words (§3):
  `lookupHuman(wallet)` and a recovered-signer check, consumed
  through the W0 core rather than re-implemented. Package
  answers: `verifyAddress` (the lookup, with the
  unknown-vs-unregistered separation W3's verify page also
  requires, its §7.2 check 4), `verifySignedMessage` (§4.1) for
  the seal's own domain-separated payload
  (`w3-provenance-seal:v1` — W3's format, W3's prefix, verified
  with the package's recovery path), `hashHumanId` and
  `truncateAddress` for its display rules. W3's subject type is
  its own (`content` / surface-scoped seals); it registers
  through `resolveStatus`'s resolver pattern if it wants the
  composition, and its anchor machinery (World Chain anchoring
  of content hashes) is explicitly not package scope — the
  package reads AgentBook, it does not write chain state.
- W4, callback-verified EA. Needs (its spec, Open Questions 8):
  a lookup result that distinguishes "not registered" from
  "lookup failed" at the API level. Package answers exactly
  that: `unregistered` vs `unknown` are different statuses with
  different failure codes, and W4's page renders them
  differently ("could not be checked just now" is never "not
  registered"). Also: `resolveStatus` on an `address` subject
  for Cole's per-task page (live lookup on page load, checked-at
  printed, ≤60 s caching is W4's service rule, not the
  package's), `verifyAttestation` with subject type
  `cole_task` for the signed task record, and
  `truncateAddress` for its code-gated view. W4's approval path
  is W2's record, not the package's; the package verifies
  Cole's wallet and task signature, never the fresh approval.

Net rule for future consumers, including Wave 2's W5/W6: a new
consumer brings a subject type, a resolver, and its own profile
checks. If it believes it needs a new core export, that is a
package change proposal routed through the coordinator to the
package's owners (W0 chat + this chat), versioned per §4.5 —
never a fork of the verification logic into consumer code,
which is the failure mode the fold exists to prevent.

### 4.8 Extraction path (when a second project consumes it)

Trigger, from the portfolio Decisions log: a second project
consumes the package. Procedure, designed now so it is cheap
then:

1. The package directories move to the new repo as one unit:
   source, fixtures, generator, tests, READMEs, CHANGELOG, and
   the package's own narrative entries. Git history for the
   package paths is preserved (`git filter-repo` or subtree
   split) so "proven" states keep their dates.
2. Pre-move checklist, all already enforced while in-repo:
   standalone build and test from a clean copy of the package
   directory alone (CI job runs exactly this, so extraction day
   adds no new failures); no forbidden imports (§4.0); package
   version and API surface frozen and documented; consumers in
   the W1 repo switch to the published/locked version rather
   than the workspace path in the same change that moves it.
3. What stays in the W1 repo: the Discord layer (§4.6) as a
   consumer-side adapter, unless the extraction decision says
   otherwise; the registry; the bot, page, and badge service as
   consumers. What moves if the coordinator decides the badge
   service is W0's to keep: `badge-service/` is already a
   consumer of the package, not part of it, so it can move or
   stay on the same terms.
4. After extraction, this design's §4 is superseded by the new
   repo's spec, and the W1 repo records the package as an
   external dependency with a pinned version, like any other.

## 5. Component 3 — Reference verifier bot (self-host package)

Deployment model, decided Oct 25, 2026 (Nic, via the
coordinator): v1 ships self-host only, plus the static verify
page. There is no project-run hosted verifier bot in v1, and
nothing in this section should be read as one:

- The bot is a self-host package. Each adopting server (guild,
  community, operator) runs its own instance, under its own
  Discord application and its own bot token, on infrastructure
  it controls. There is no central bot to invite and no shared
  tenant: an instance serves the guilds its operator adds it
  to, holds only that operator's token, and its SQLite state
  never leaves the self-hoster's machine. Setup docs (§7) walk
  an adopter through creating their Discord application —
  that per-instance application is also why §3.1 could make the
  application ID the attested identity: the verifier bot's own
  application is the operator's, not the project's.
- The no-install check is the static page (§6.1). A guild that
  wants the Human-backed role without running anything gets
  manual verification there and grants the role by hand; the
  role automation is what self-hosting buys. README copy must
  present it in exactly that order — page first (no install),
  bot second (automation, self-hosted) — so no reader is left
  expecting a hosted bot the project does not run.
- The project's own §9 test instance is Nic self-hosting the
  package for his guild like any adopter, with his own token;
  it is a test of the shipped artifact, not a public service,
  and it is not offered to other guilds.
- A hosted, project-run instance is a possible v2 addition
  only. It would be a new decision with its own trust and
  operations review (a hosted verifier is a trust magnet and a
  service commitment, which is why v1 excludes it), and nothing
  in v1 — no endpoint, hostname, credential, or data model
  choice — is built in anticipation of it beyond the package's
  existing statelessness. The public/private gates in §10 stand
  unchanged either way.

### 5.1 Shape

- TypeScript on `discord.js` v14, using the verify package (§4)
  through its Discord subpath (workspace dependency — the bot is
  the package's first consumer and its integration test). Node
  20+, single process, no web server except the optional badge
  endpoint (§6.3) which binds only when configured.
- State: one SQLite file (`better-sqlite3` or Node's built-in
  `node:sqlite` at build-time choice; schema below), in a data
  directory the self-hoster controls. No hosted database, no
  external services beyond Discord, the registry/attestation
  hosts, and a World Chain RPC.
  Tables: `guild_config(guild_id, role_id, registry_url,
  sync_interval_minutes, log_channel_id)`,
  `binding(guild_id, application_id, attestation_url,
  payload_hash, bound_via, bound_by, bound_at)`,
  `check_log(id, guild_id, application_id, checked_at, status,
  failures_json, wallet, human_hash, expires_at)` — `status` is
  the package's `VerificationStatus` (§4.1), stored verbatim so
  `unknown` and `unregistered` stay distinct in the guild's own
  history, exactly as they are in the result.
  `check_log` is append-only and pruned by age (default 90 days)
  so a self-hoster can answer "when did this role last verify?"
- Configuration is environment + a per-guild `/fiador
  setup` admin flow: bot token (env only, never in the DB),
  default registry URL, default RPC URL, sync interval default.

### 5.2 Commands and events

All slash commands, all responses ephemeral except status
summaries an admin explicitly asks to post.

- `/fiador` — status of this guild: which bots are bound,
  each one's last check result and `checkedAt`, role member count.
- `/fiador setup` (Manage Guild) — pick or create the
  "Human-backed" role, set registry URL / sync interval / log
  channel. Refuses, with instructions, when the bot's own role
  sits below the Human-backed role in the hierarchy (it cannot
  grant what it cannot manage) or when it lacks Manage Roles.
- `/verify-agent <bot-user | application-id>` — one-off check,
  no state change. Renders the result embed (§5.3) with the
  failure sentence for any failure code.
- `/attest <url | paste>` (operator flow, install-time claim) —
  verifies, and on success creates/updates the guild binding and
  triggers a role decision for that bot. On failure, reports the
  failure sentence and stores nothing. Rate-limited per user
  (§5.4). Anyone may run it (the cryptography, not the caller's
  identity, is the gate), but role changes only ever follow a
  passing verify.
- `guildMemberAdd` / bot-join path: when a bot joins, the bot
  attempts registry discovery by application ID; if found and
  verified, it binds and grants, and logs the grant. If not
  found, it logs "no attestation found" once — it never DMs the
  bot owner (no unsolicited outreach surface in v1).
- Role sync loop (§5.5) and, on startup, a full re-check before
  announcing readiness in the log channel (a restart must not
  leave stale grants unexamined longer than one interval).

### 5.3 Presentation

- Result cards are designed in both Discord themes (§6.0):
  embeds reuse the approved badge states in their dark and
  light variants — verified (gold/cerulean), expired (muted +
  "expired"), unverified (grey) — and are screenshot-checked
  against Discord light and dark in the §9 test. Colour tokens
  from `~/workspace/world-visual-assets/` (Nova Glass: starfield
  `#0A0B13`, graphite `#1C1C1E`, cerulean `#4A7FA5`, label cyan
  `#8ABAD3`, eye gold `#D4A55D`, amber `#C9933A`). Embed text shows:
  bot name, application ID, wallet (truncated `0x1234…abcd`),
  humanHash (truncated), expires, checked time, and — only when
  the payload carries it — the operator display name, rendered
  as `Operator (self-asserted): <name>` (§3.1.1); when absent,
  no operator line appears at all. The raw humanId
  is never rendered — under the hash-only settlement (§3.3) the
  payload a verifier holds has no raw value in it to render, and
  the value the verifier resolves privately for the check is
  never a display field at all.
- The role is named exactly `Human-backed` by default (guilds may
  rename; the bot tracks it by role ID, not name).

### 5.4 Bot-side safety (mandatory, not optional polish)

- Fetch guards for every operator-influenced URL (attestation and,
  transitively, nothing else — the bot follows no links inside a
  payload): HTTPS only; DNS resolves to public addresses only
  (reject loopback, RFC1918, link-local, and the cloud metadata
  range, checked after resolution and again at connect — the
  playground's `url-guard.ts` pattern of pinning vetted addresses
  is the reference, and the badge service's fetcher in the W0
  spec §4.7 is the same machinery); no redirect following (a 3xx
  is a failed fetch, because the redirect target was never
  vetted — operators host the attestation at its final URL);
  5 s timeout; 64 KiB body cap; `application/json` expected but
  not required (parse attempt decides); no credentials in URL.
- `/attest` rate limit: 5 attempts / user / guild / 10 min,
  in-memory. Registry and RPC traffic is cached per interval,
  not per command, so a popular guild cannot be used to hammer
  an operator's hosting or a public RPC.
- Token hygiene: token from env, never logged, startup log prints
  the bot's own user ID and guild count only. Intents requested:
  Guilds + GuildMembers (for bot-join and role work) — no message
  content intent; this bot reads no messages, and the README
  says so, because a verification bot that reads chat would
  contradict the project's trust posture.
- Least privilege documented for self-hosters: the invite URL
  they generate for their own instance (adding their bot
  application to their guild) requests Manage Roles + Slash
  Commands only. There is no project-issued invite URL in v1
  (§5 deployment model).

### 5.5 Sync loop semantics

- Default interval 6 hours per binding, jittered ±10%, per-guild
  override via setup. On each check: verify; if status is
  `verified` and role missing, grant; if status is `invalid`,
  `expired`, or `unregistered` and role present, revoke and log
  with the failure sentence. Status `unknown` (the lookup itself
  failed) revokes nothing, ever: it retries once 15 min later,
  and a second consecutive `unknown` raises a log-channel
  warning instead of a revocation — a transient RPC outage must
  not mass-revoke a guild. Expiry and signature failures revoke
  on first observation. This asymmetry is deliberate and
  documented in the README: chain unavailability is our problem,
  a lapsed attestation is the operator's. It is also only
  expressible because the package keeps `unknown` distinct from
  `unregistered` (§4.2); a boolean result would force the bot
  to choose between mass-revoking on outages and never revoking
  on real deregistrations.
- Every grant/revoke writes `check_log` and, when a log channel
  is configured, one compact line there. No other chatter.

## 6. Component 4 — Static verify page and served badge

### 6.0 Both modes, every public surface (standing rule)

Recorded Oct 25, 2026 (program standing rule; it is also Nic's
standing website preference from the same day: a light-only
site is unfinished). Every public surface this workstream
designs ships in both light and dark mode:

- Surfaces in scope: the verify page (§6.1), the README header
  treatment (§7), any registry page or web view of the registry
  (the §3.4 mirror, if it presents one, and any entry browser
  built over `registry.json`), the verifier bot's result cards
  (§5.3), and the served badge (§6.3, which already carries
  `theme=dark|light`).
- Both variants are designed and checked, not one recolored
  from the other: each mode gets its own pass over contrast
  (WCAG AA in both), state colours (verified / expired /
  unverified must be distinguishable in both, by more than
  colour alone), and imagery. The approved badge SVGs already
  carry dark and light variants (`world-visual-assets/badges/`);
  surfaces build from the matching variant, never from a
  CSS filter over the other mode's art.
- Pages (verify page, registry view): first visit follows the
  system preference (`prefers-color-scheme`), a manual toggle
  is on the page, and the choice persists (localStorage, no
  account, no tracking implied by the storage). No page ships
  a toggle that only flips a class on one designed theme — both
  themes exist as designed token sets (Nova Glass dark, and
  its light counterpart from the same asset batch).
- README header: GitHub renders the reader's theme, so the
  header uses a `<picture>` element with
  `prefers-color-scheme` sources, serving the dark and light
  header treatments (banner crop + badge variant per §6.2) to
  match. Both crops are produced and checked; a single banner
  that happens to survive both themes is not compliance.
- Bot result cards: Discord's own client theme is the reader's,
  so embeds and any card imagery are checked against both
  Discord themes (light and dark) in the §9 guild test, with the
  badge variant and accent colours chosen to hold contrast in
  each. Text carries the state in words in both themes, as
  everywhere else in this design.

### 6.1 Static page (`verify-page/`)

- One static site, no backend, no build-time secrets, deployable
  to any static host (the repo ships it as plain files plus an
  optional bundling step). It bundles the verify package's core
  (browser build via `esbuild`, with the injectable reader
  pointed at a browser RPC client — the reason the core has no
  Node-only dependency in its public surface, W0 spec §5) plus
  the Discord subpath, so the page and the package can never
  drift: same code, same statuses, same sentences.
- Three input modes, matching §4.6: application ID (+ registry
  URL, prefilled with the repo registry), attestation URL, and
  paste-a-payload (JSON text or dropped `.json` file).
- Chain read runs in the visitor's browser against a World Chain
  RPC (prefilled public default, editable). CORS reality is
  documented in-page: attestation hosts and registries that do
  not send `Access-Control-Allow-Origin` can block the browser
  fetch; the paste mode is the no-CORS fallback, and the
  operator walkthrough tells operators to serve
  `Access-Control-Allow-Origin: *` on attestation files (the
  payload is public and signed; CORS openness costs nothing).
- Result view: the badge graphic for the observed state, the
  §5.3 field set (including its display-name rule: shown only
  when the payload carries one, labelled self-asserted,
  §3.1.1), the failure sentence when invalid, and
  `checkedAt`. Plus the honest-limits paragraph (§1) on the page
  itself, above the fold of the result — the page is the demo
  surface strangers will judge the claim by.
- Styling: Nova Glass, the house style (§8.1 credit model) —
  the §5.3 tokens, the approved banner art as the page hero
  (§6.2), and the badge graphics for results, in both light and
  dark mode per §6.0 (system preference on first visit, manual
  toggle, choice persists, each mode designed and checked from
  its matching badge/banner variant). The page carries
  no product branding for Fiador beyond its name and no World branding;
  its footer carries the factual credit line ("Created by Nic
  Lydon", independent open source, §8.1) and nothing that reads
  as endorsement in either direction.
- Privacy: all checks run client-side; the page ships no
  analytics, no fonts or scripts from third-party CDNs (self-host
  everything, so the page itself demonstrates the posture), and
  the README states that the only network calls are the ones the
  visitor triggered (registry, attestation host, RPC).
- World's official Human Badge may appear on this page only
  beside the operator's own verification and only unmodified,
  per the IDKit guidelines summarised in the spec; the project's
  own Fiador badge is the result mark. Default v1 page
  ships without the official badge at all (avoiding the question
  entirely) unless the coordinator review asks for it.

### 6.2 Visual assets wired in

Source of truth until repo creation:
`~/workspace/world-visual-assets/`.

- `badges/`: 12 hand-coded SVGs — pill + icon-only × dark + light
  × verified / expired / unverified — generated by
  `badges/generate_badges.py` (edit the generator, rerun, never
  hand-edit outputs). These copy into the repo under
  `assets/badges/` with the generator and its README, which
  carries the dynamic-badge spec the next section implements.
- `generated/fiador-banner.webp` (2240×1120): repo social
  preview and README header base (crop to 2512×816 for the header
  format used by the muse-discord banner, per the assets README).
- `generated/fiador-server-icon.webp` (1600×1600): the demo
  guild / verifier bot avatar base.
- Verify-result card set (verified / expired / failed embeds)
  reuses the same states and tokens; no new art is commissioned
  for v1.

### 6.3 Dynamic served badge

- Endpoint: `GET /badge/<discord_application_id>.svg` and `.png`.
  Response renders the §6.2 design for the state observed by a
  check performed at request time (or served from a cache of at
  most 5 minutes), with the check time in small type on the
  badge, `Cache-Control` max-age in minutes, and the correct
  state even under copy-paste to another context (§1).
- Implementation home in v1: a tiny standalone service in
  `badge-service/` consuming the verify package, runnable next
  to the verifier bot or alone. This service is W0's second
  deliverable; its full specification (routes including the
  typed `/badge/:subjectType/:subjectId` form and the JSON
  status route, the status-to-badge mapping, the cache table —
  300 s verified/expired, 60 s negative, `no-store` on
  `unknown`, stale-on-error bounded at 900 s with the original
  check time rendered — and its abuse posture) is the W0 spec
  §4, which governs where this summary and it differ. The
  service is a consumer of the package, not part of it (§4.8).
  Like the verifier, it ships code-only in v1 (decided, §5):
  no project-run badge instance is offered; adopters self-host
  it next to their own verifier or link the static page
  instead. A hosted badge endpoint follows the same possible-
  v2 path as a hosted verifier, under the same future decision.
- Documented check API; evidentiary outputs (design
  constraints, held since the first revision and restated here
  so the badge service is built to them). (a) The badge
  service's JSON status route (§4 / W0 spec §4: typed
  `/badge/:subjectType/:subjectId` routes plus the JSON status
  route) is a published API contract from v1, not the badge's
  private plumbing: its response is the package's full
  public-safe `VerifyResult` (status, failure codes, wallet
  truncated, humanHash, expiry, `checkedAt`), it is versioned
  with the package, and the package README documents it as an
  API other verifiers can rely on. A verification result that
  third parties act on should have one stable, documented
  shape; every consumer inventing its own is how incompatible
  "verified" claims happen. (b) A check result is an
  audit-shaped record, not a boolean: the bot's `check_log`
  (§5.1), the page's `checkedAt` display, and
  `docs/verification.md` entries all carry who/what/when/
  status/failures, so any later reader — a guild admin
  disputing a revocation, an operator debugging a lapse — can
  reconstruct what was observed and when, from records the
  system already produces. (c) Every consumer of verification
  (bot, page, badge, third-party tools) reads through the same
  stateless package and the same result shape; no consumer
  gets a private variant of the truth.

### 6.4 Attestation link preview — the `/v/` surface

A first-class surface (design addition from Nic, Oct 25, 2026).
The demonstration shape of the whole project is a bot posting
one short link in a channel; this surface is what makes that
link speak for itself.

- Canonical URL: `https://fiador.org/v/<short-id>`. (Domain
  state, updated Oct 26, 2026: `fiador.org` is REGISTERED via
  Cloudflare Registrar (active, auto-renew on), so the
  canonical-domain blocker for this surface is cleared on the
  registration side. DNS and hosting for it still await the
  deploy decision through the coordinator (§6.4 hosting
  posture); until then the endpoint is built and tested on a
  staging host and no `/v/` link is published. The rule itself
  stands: the surface ships only on the canonical domain — a
  preview card served from anywhere else is not this surface.)
- Short-id: content-derived and tamper-evident. The id is the
  first 10 characters of the base32 encoding of
  SHA-256 over the attestation's canonical signing bytes
  (§3.2) — any change to the payload changes the id, so a link
  names one exact attestation, not a slot whose contents can
  be swapped. Resolution needs no accounts and no database:
  the preview resolves the id against the published registry
  (registry entries carry the payload hash, §3.4; the service
  matches the id against indexed entries, extending the id
  length for an entry if a collision ever appears, minimum 10
  characters). Registry tombstones (an entry marked revoked)
  keep their ids resolvable precisely so old links render a
  revoked card instead of silently becoming not-found.
- The endpoint: a small dynamic handler (an edge function is
  fine; reference implementation ships beside the badge
  service, same operational family). On a crawler request it:
  resolves the id, fetches the attestation, runs the same full
  verification as the verify page (signature, expiry, live
  AgentBook read at crawl time, through the verify package —
  no second implementation of the checks), and returns Open
  Graph meta plus a dynamically rendered `og:image` card
  (1200×630) in the Nova Glass language. Card contents: the
  badge state artwork for the observed state (verified /
  expired / unverified / revoked — colours and states matching
  the §6.2 badge set exactly, rendered from the same assets),
  the Discord application name, the operator display name ONLY
  if the attestation opted in (§3.1.1), the descriptor line
  ("Fiador — human-backed attestation for Discord bots", per
  the §7 descriptor rule), the verdict in words, and the crawl
  timestamp ("checked <time> UTC"). Meta: `og:title` carries
  Fiador + descriptor + application name + state; `og:description`
  carries the verdict sentence and the snapshot caveat below;
  `twitter:card` is `summary_large_image`.
- Human click-through: browsers (non-crawler user agents)
  land on the full verify page with the attestation prefilled;
  the page re-runs all checks client-side at open time.
  Serving OG meta to crawlers and the real destination to
  humans is the standard link-preview arrangement, stated here
  so nobody later mistakes it for cloaking: the crawler
  content and the human content are the same verdict, rendered
  for two readers.
- Honesty spec, plainly (extends §1 to this surface; the copy
  ships on the card's destination page and in the meta
  description, not only in this design): the OG card is a
  snapshot from crawl time, not the proof. Platform preview
  caches mean a later expiry or revocation may never refresh a
  preview already posted; a lookalike domain can imitate a
  card pixel for pixel. The verification is the click-through
  check on the canonical domain, run live at open time. The
  card itself carries its crawl time for exactly this reason,
  and no copy anywhere presents a preview screenshot as
  evidence of current state.
- Failure states, fail-closed like the core (§4.2): an unknown
  id renders a neutral "attestation not found" card with full
  OG meta — never a bare 404 with no meta, and never anything
  that could be mistaken for a state. A lookup failure at crawl
  time (registry, attestation host, or RPC unreachable)
  renders an explicit "could not check" card in the unverified
  visual family with the reason in words, served `no-store` —
  never a verified-looking card, and never cached into looking
  settled. A payload that fails verification renders its real
  state (expired / unverified / revoked), in words, using the
  same failure sentences as §5.3.
- Modes: the card is a rendered image and carries no theme
  variant of its own (like the §6.2 banner, it is one designed
  artifact); the destination page it leads to is fully
  both-modes under §6.0.
- Hosting posture (Nic, Oct 26, 2026): v1 hosting for the
  Fiador web surfaces — site, verify page (§6.1), and this
  preview endpoint — is Vercel, right-sized for what v1 is: a
  small Discord demonstration, not a crowd. Two constraints
  are standing, not preferences. (1) PORTABILITY: the preview
  endpoint and the verify surface depend only on the verify
  core and the published attestation registry — nothing
  Vercel-specific beyond the thinnest adapter at the edge, so
  a move to Cloudflare (Workers/Pages) is a relocation, not a
  rewrite. Cloudflare is recorded as the natural scale home to
  evaluate — the program's domains and DNS already live there
  — on real traffic numbers, not instinct, if the question
  ever becomes live. (2) COST WATCH: the on-chain verification
  reads are free, but serving pages and previews is not free
  at scale, and funding public verification traffic out of
  pocket indefinitely is not a standing commitment. If usage
  grows past hobby scale, the traffic/cost picture goes back
  to the coordinator as a decision item with numbers; it is
  never absorbed silently by whoever happens to be operating
  the surface that month.

## 7. Examples and docs

- `examples/discord-js-bot/` — a minimal bot plus the 15-line
  operator story: it does not import the library at all; it just
  links its attestation from its repo README. Demonstrates the
  "almost no bot code change" claim honestly.
- `examples/discord-py-bot/` — same, Python ecosystem.
- `examples/publish-your-attestation/` — the walkthrough:
  register wallet in AgentBook (linking World's docs), draft
  payload, sign with `tools/`, host the file (GitHub raw, Pages,
  or any static host, with the CORS header), open the registry PR.
- `examples/muse-discord-adapter/` is NOT v1. A README stub notes
  it as planned v2 so nobody files it as missing.
- README structure (stranger-first, per spec): the Nova Glass
  header (banner art in both light and dark treatments via a
  `<picture>` element, §§6.0, 6.2), the §8.1 author block ("Created by
  Nic Lydon") directly under it, what this proves / does not
  prove (§1 wording), operator quickstart, guild-admin
  quickstart, verifier/developer quickstart, registry link,
  badge link, threat model link, licence (Apache-2.0, §11
  resolved), and the plain statement that this is independent
  open source built on World's public surfaces, with no implied
  endorsement and no World marks in the project name or badge.
- Naming in public copy — the descriptor rule (binding, Nic,
  Oct 25, 2026): Fiador never appears naked in public copy. On
  first use in every surface it travels with its descriptor,
  "human-backed attestation for Discord bots" — README, spec
  and design title blocks, badge-adjacent copy (alt text,
  captions, the badge page's headings), registry listing copy,
  and outward posts alike. The pattern matches the umbrella
  rule (Operator Verified travels with "verified as a unique
  human"): an opaque name is fine, an unexplained one is not.
  After the first use, bare "Fiador" is normal. This design's
  own title follows the rule; §10's copy checks enforce it on
  launch surfaces, and the badge artwork itself is exempt by
  construction (its label is the word "fiador" in a state mark,
  and the pages around it carry the descriptor).
- The README also carries the program's no-token position,
  stated on purpose (program direction, Oct 25, 2026): Fiador
  has no token, will not issue one, launches nothing, and
  verification is never something to buy or speculate on; any
  token claiming the Fiador name is unaffiliated. The statement
  sits in the positioning section (not buried in an FAQ),
  because in this ecosystem the absence of a token is a trust
  claim the enterprise-adjacent reader is checking for.

## 8. Repo layout (public repo, when Nic gives the go)

```
fiador/                              # repo niclydon/fiador (created as human-backed Oct 25, 2026,
                                     # renamed to Fiador the same day; founding commit ed7f840)
  README.md                          # §7 structure; honest limits above the fold
  SPEC.md                            # protocol, versioned (this design's §§1,3 as normative text)
  LICENSE                            # Apache-2.0 full text, Copyright 2026 Nic Lydon (§8.1)
  NOTICE                             # Apache-2.0 attribution notice (§8.1); required, not optional
  CHANGES.md
  docs/
    threat-model.md                  # §1 expanded; adversarial-review record linked
    verification.md                  # live-run evidence with dates (quality bar 4/6)
    narrative/                       # arc-close narratives, estate doctrine
  assets/
    badges/                          # 12 SVGs + generate_badges.py + README (from world-visual-assets)
    banner.webp  server-icon.webp
  registry/
    registry.json  registry.schema.json  attestation.schema.json
    CONTRIBUTING.md
  packages/
    verify-ts/                       # §4 THE VERIFY PACKAGE (W0 core, TS):
                                     #   src/ (core + discord/ subpath), fixtures/ (§4.4,
                                     #   inside the package so extraction is self-contained),
                                     #   tests/, package.json ("author": "Nic Lydon",
                                     #   "license": "Apache-2.0"), README.md, CHANGELOG.md,
                                     #   attestation.schema.json (generic, §3.1)
    verify-py/                       # §4 the parity port: src/, tests/, pyproject.toml
                                     #   (authors = ["Nic Lydon"], license Apache-2.0),
                                     #   README.md; versions in lockstep with verify-ts (§4.5)
  verifier-bot/                      # §5: src/, Dockerfile, .env.example, README
  verify-page/                       # §6.1 static site
  badge-service/                     # §6.3 small service (W0 deliverable 2; a package consumer)
  link-preview/                      # §6.4 /v/ endpoint: OG meta + dynamic card (edge-deployable)
  tools/
    sign-attestation/                # §3.2 reference signer CLI
  examples/
    discord-js-bot/  discord-py-bot/  publish-your-attestation/
    muse-discord-adapter/README.md   # v2 stub only
  .github/workflows/
    ci.yml                           # schema checks, both test suites, fixture parity,
                                     # secret scan (see §10) on every PR
```

Monorepo, one repo for v1 — and that is now decided, not a
recommendation: Nic chose W1 as the program's first repo with
W0 folded in as the verify package (Oct 25, 2026, portfolio
Decisions log). The package's boundary (§4.0) is drawn so the
fold costs nothing later: extraction triggers when a second
project consumes the package, and §4.8 is the procedure. No
submodules; the visual assets copy in at creation, and their
generator remains the editing path.

### 8.1 Credit model — name stamp plus house style

Decided Oct 25, 2026 (Nic, via the coordinator). Fiador is
presented as a protocol and a reference implementation by a
named person, never as a product line. The project has a name
(Fiador, since the rename) and a personal credit; it does not
acquire a brand identity beyond those. The complete model, and
nothing beyond it:

- Name stamp: `LICENSE` carries "Copyright 2026 Nic Lydon"
  (Apache-2.0 appendix form). `NOTICE` carries the Apache-2.0
  attribution in the form the licence contemplates: the project
  name, the copyright line, and a statement that the work is
  provided under the Apache License, Version 2.0 — factual
  attribution, no tagline. Both verify-package manifests carry
  the author field (`"author": "Nic Lydon"` in `package.json`;
  `authors = [{ name = "Nic Lydon" }]` in `pyproject.toml`)
  alongside `"license": "Apache-2.0"`. The verifier bot's and
  badge service's manifests do the same, so there is no surface
  in the repo where authorship is ambiguous or corporate.
- README author block: directly under the README header, before
  the quickstarts, a short author block whose operative line is
  "Created by Nic Lydon", with the independent-open-source
  statement (§7) beside it. No author photo or personal branding
  beyond the name itself; the block credits a person, it does
  not market one.
- House visual style, with the project name and nothing more:
  the banner, the verify page, and the README header are styled
  in Nova Glass in both light and dark mode (§6.0) — the house
  style, tokens in §5.3 — using the approved assets in
  `~/workspace/world-visual-assets/` (§6.2: banner, server icon,
  the badge set). The rename to Fiador (header note) gives the
  project its name and its badge word: the badge artwork label
  reads "fiador", and Fiador is the wordmark wherever a project
  name appears. That is the extent of the branding: no logo
  beyond the badge's eye mark, no mascot, no product-line
  identity, and no program umbrella name set up to compete with
  World's (Nic's possible "Operator Verified" umbrella is a
  linking page the repos point to, not a brand over Fiador).
  The Fiador badge remains what it always was in this design:
  a protocol state mark that reports a check result (§6.2), not
  a product logo; it is never used as a brand lockup in headers
  or marketing beyond carrying the project name.
- Attribution wording stays factual, everywhere: "Created by
  Nic Lydon", "independent open source", "built on World's
  public AgentBook / AgentKit surfaces" are the ceiling of the
  claim. Wording must never imply World endorsement, partnership,
  or authorship, and the coordinator's §10 claims read checks
  credit copy on exactly this point. A reader should be able to
  tell in one glance whose work this is (Nic's) and whose it is
  not (World's, or a company's).

## 9. Test plan — Nic's guild end to end

Test bed: Nic's guild (`niclydon.io`), where he is owner and the
Nova bot already operates. Same pattern as the muse-discord
community-seat trial. Nothing installs in the community guild on
spec; step 6 is a pitch, made only after steps 1–5 pass, and the
admins' call is final.

Preconditions (state at design time, re-check at test time):

- [ ] Orb verification: DONE, Oct 25, 2026 (Nic, NYC).
- [ ] Playground wallet AgentBook registration: DONE, live check
      `registered: true`, Oct 25, 2026 evening. Re-run
      `agentkit_status` at test start and record the output in
      `docs/verification.md`; a registration state is a fact with
      a date, not an assumption.
- [ ] A dedicated demo wallet for the public artefacts (portfolio
      rule: demos run on throwaway or dedicated wallets; the
      fleet's operational keys are never demo keys). Election
      recorded Oct 25, 2026: the dedicated World Program wallet
      (created Oct 25, held separately from the playground /
      fleet wallet) is the signing wallet for all public demos,
      the founding attestation, and registry listings. Its
      AgentBook registration is prepared; the one remaining
      step is Nic's World App approval tap, after which the
      registration state gets the same dated `agentkit_status`
      record as the item above before §9 step 1 signs anything.

Steps:

1. Publish Nova's attestation.
   - Draft payload for the Nova Discord application (application
     ID + bot user ID from the live bot, not from memory), sign
     with the demo wallet, host at a public HTTPS URL with CORS
     open, add the registry entry by PR in the (then-created)
     repo. Record: payload hash, URL, signing date. The payload
     carries `operator_display_name: "Nic Lydon"` — Nic's fleet
     opt-in under §3.1.1, since his bots already operate
     publicly as his.
2. Package and page verification, happy path.
   - Verify package via its Discord layer: by application ID
     (registry), by URL, by pasted payload — three results with
     status `verified`, identical `humanHash`, and evidence
     `checkedAt` recorded for each.
   - `verifyAddress` alone on the demo wallet: status
     `verified`. This is the W2/W3/W4 consumer path (§4.7)
     exercised inside the W1 test, so the package's non-Discord
     surface has live evidence too, not only unit fixtures.
   - Python port: same checks, results diffed against TS output.
   - Static page: same three modes in a clean browser profile;
     screenshot the verified result for `docs/verification.md`
     (identifiers truncated in the screenshot per §10), in both
     light and dark mode (§6.0): system-preference default, the
     toggle, and persistence each exercised once.
3. Failure cases, package + page (each must produce the named
   status and failure code, and no thrown exception):
   - expired attestation (status `expired`, code `expired`) —
     a second, deliberately short-lived payload, allowed to
     lapse or clock-injected
   - wrong application ID (`subject_mismatch`, core; the
     Discord layer surfaces it as an application-ID mismatch)
   - wrong signer (`signature_mismatch`) — payload signed by an
     unrelated generated wallet
   - unregistered wallet (status `unregistered`, code
     `not_registered`) — payload correctly signed by a
     generated, never-registered wallet
   - tampered payload (edit `operatorDisplayName` after
     signing: `signature_mismatch`; repeat with a tampered
     `extra.discord_bot_user_id`: same result, proving `extra`
     is inside the signature)
   - RPC pointed at a wrong chain or taken offline (status
     `unknown`, code `lookup_failed`, fail closed — and the
     page and bot must render it as "could not be checked",
     never as "not registered")
4. Verifier bot in Nic's guild.
   - Invite a dev instance (separate application from any future
     public instance), run `/fiador setup`, create the
     Human-backed role.
   - `/verify-agent` on Nova: embed shows verified state, in
     both Discord client themes (light and dark screenshots,
     §6.0).
   - `/attest` with Nova's URL: binding stored, role granted to
     the Nova bot. Confirm the grant in the guild UI, not only in
     bot logs.
   - Swap the binding to the deliberately expired payload from
     step 3: on the next sync tick (force one via the admin
     re-check), role is removed and the log line carries the
     `expired` sentence. Restore the good binding, role re-granted.
   - Point the bot at a dead RPC for one sync tick: role is NOT
     removed (status `unknown`, §5.5), the warning line is
     logged, and restoring the RPC returns the binding to
     `verified` with no manual re-bind.
   - Leave the sync loop running across one full natural interval
     (6 h default, or a shortened test interval recorded as such)
     and record the `check_log` rows for the interval in
     `docs/verification.md`.
5. Served badge.
   - Badge URL for Nova's application ID renders verified with a
     current check time; swap to the expired binding and confirm
     the badge decays to expired within its cache window; an
     invented application ID renders unverified, never an error
     image.
5a. Link preview (§6.4).
   - Post Nova's `/v/` link in a test channel: the Discord
     preview renders the verified card (badge state art matching
     the §6.2 set, application name, operator display name —
     present only because Nova's attestation opted in — the
     descriptor line, and the crawl timestamp).
   - Click through: lands on the verify page prefilled, which
     re-runs the check live and agrees with the card.
   - Swap to the expired binding, post the (different, content-
     derived) link fresh: the card renders expired. Record the
     cache caveat live: the OLD message's preview does not
     update, which is the documented behaviour (§6.4), and the
     verification.md entry says so rather than calling it a
     defect.
   - Unknown id: renders the neutral "attestation not found"
     card with meta intact. Crawl-time failure (endpoint's RPC
     path blocked in the test env): renders "could not check",
     `no-store`, never verified-looking.
6. Community guild pitch (not a test step, an outward step —
   gated on Nic's go like every outward send, §10).
   - Pitch is an adoption decision for that guild's admins, with
     the working demo above as evidence. Nothing is installed
     there during the pitch.

Exit criteria: steps 2–5a all recorded in `docs/verification.md`
with dates and outputs; any step that cannot pass is recorded as
"not verified" with the blocker, per quality bar 4 — a green
summary without the underlying run does not close this plan.

## 10. Launch checklist — secret scan and privacy gate

From the portfolio's binding public/private boundary. No item is
waivable by the workstream; the coordinator performs the privacy
read, Nic gives the repo and push gos.

Before repo creation (Nic's go) — executed for the founding
tree Oct 25, 2026; these items stand as the record of what was
checked, and re-apply to any future repo in the program:

- [x] Repo name: created as `human-backed`, renamed the same
      day to `fiador` (Nic, Oct 25, 2026; rename verified live
      from this seat via `gh`: `niclydon/fiador` is
      public and the old URL redirects). Neither name contains
      a World mark or implies endorsement (portfolio trademark
      rule). The creation-day availability checks were run from
      both seats, as recorded in §11's resolved list.
- [ ] Creation go itself: the name and licence decisions were
      NOT the go. Creation happened only on Nic's explicit go
      through the coordinator, after the remaining §11 decisions
      land. Nothing in this design, and no earlier decision,
      substitutes for it.
- [ ] Licence in place: Apache-2.0, the program default decided
      Oct 25, 2026 — full licence text in `LICENSE` at repo
      root, licence headers or a licence note where the verify
      package's files conventionally carry one, and the README
      licence section naming Apache-2.0. No per-repo licence
      decision is needed or taken; a future repo that departs
      from the program default needs its own recorded decision,
      not a silent variation.
- [ ] Credit model in place (§8.1), every element checkable in
      the tree: `LICENSE` carries "Copyright 2026 Nic Lydon";
      `NOTICE` is present with the Apache-2.0 attribution;
      author fields read "Nic Lydon" in the package, bot, and
      badge-service manifests; the README carries the "Created
      by Nic Lydon" author block under its header; and the
      banner, README header, and verify page use the Nova Glass
      house styling from the approved visual assets — and no
      brand asset beyond the Fiador name and the badge's eye
      mark exists anywhere in the tree.
- [ ] humanId settlement verified in the tree (§3.3, decided
      Oct 25, 2026): the attestation format carries the hash
      only, under the construction §3.3 specifies; no raw
      humanId field exists in the profile schema, the signer CLI
      emits hash only, and the walkthrough text describes hash
      only — there is no disclosure election left to choose.
- [ ] Deployment model matches the decision (§5): v1 ships
      self-host only plus the static verify page. The tree
      contains no project-run hosted verifier or badge
      endpoint, no project credential or hostname for one, and
      the README presents the page as the no-install check and
      the bot as a self-host package with the adopter's own bot
      token. A hosted instance appears nowhere in v1 copy,
      including as a coming-soon promise; it is recorded as a
      possible v2 addition in §5 only. (The public/private gates
      in this checklist stand unchanged by this decision.)

Before the first public push (all must pass, results recorded in
the repo's `docs/narrative/` launch entry):

- [ ] Secret scan over the full tree AND full git history:
      `gitleaks` (or `trufflehog`) run by CI and once manually
      pre-push; zero findings, or every finding dispositioned in
      writing in the launch entry. Scan covers: wallet private
      keys, Discord tokens, RPC API keys, `.env` files (repo ships
      `.env.example` only), vault references by value (by name is
      fine), SSH keys, and the playground `.env` path specifically
      (the seed code reads a key from `.env`; that file and its
      path conventions must not leak into fixtures or examples).
- [ ] Privacy read of README, all `docs/`, examples, and fixtures
      by the coordinator, against the portfolio private zone:
      no full humanId anywhere (§3.3 hash-only settlement —
      checked mechanically as well as by eye: a scan for
      humanId-shaped values and for `human_id` / raw-humanId
      field names across payloads, registry, pages, fixtures,
      and screenshots — and, in the secret-scan pass above,
      across full git history — where every hit must be a hash,
      a content hash, or a labelled synthetic sentinel, per the
      leak-path audit in §3.3); wallet addresses
      truncated in prose and screenshots (full addresses appear
      only inside machine fixtures where the protocol requires
      them, and only for synthetic or dedicated demo wallets);
      no Nexus data, no
      calendar / comms / health content; no homelab hostnames,
      IPs, or tailnet details; no Discord tokens or guild
      internals beyond what the §9 demo strictly needs (guild
      name is already public-facing; member data is not); nothing
      about other people from Nic's private corpus.
- [ ] Fixture audit: every key in `fixtures/` is synthetic or a
      dedicated demo key, labelled as such; no fixture was
      recorded from a live operational wallet.
- [ ] Trademark / claims read: project name, badge, README, and
      page copy contain no World logo, no remixed Human Badge,
      no "official" language; the independent-open-source
      statement (§7) is present; honest limits (§1) are in the
      README above the fold, in spec wording. The same read
      covers the credit copy (§8.1): attribution is factual
      ("Created by Nic Lydon", named-person credit and NOTICE
      wording only) and nothing in the author block, banner,
      headers, or metadata states or implies World endorsement,
      partnership, or authorship — and nothing presents Fiador
      as a product line beyond its name.
- [ ] Adversarial review completed for the identity claim
      (portfolio quality bar 5): reviewers prompted to break the
      verification (forge, replay, confuse, SSRF the fetchers),
      findings triaged, and the review record linked from
      `docs/threat-model.md`. Launch does not proceed on an
      untriaged critical finding.
- [ ] Both-modes check (§6.0), every public surface: verify page,
      README header treatment, registry page/view if one ships,
      bot result cards, and served badge each verified in BOTH
      light and dark mode, with dated screenshot evidence filed
      beside `docs/verification.md`. Pages: first visit follows
      `prefers-color-scheme`, the manual toggle works, and the
      choice persists across reload. README: the `<picture>`
      header serves the correct treatment per mode. Bot cards:
      checked inside Discord's light and dark themes. Each mode
      is a designed variant (built from the matching approved
      badge/banner variant), contrast-checked — a surface that
      only recolors one theme, or ships one mode, fails this
      item outright.
- [ ] CI green on the launch commit: schema validation, both test
      suites, fixture parity, registry self-check, secret scan.
- [ ] Live verification evidence current: `docs/verification.md`
      reflects a run against the launch commit, dated (§9 exit
      criteria).

Before any outward post (dev.to, Discord showcase, social):

- [ ] Nic approves the exact text (portfolio gate; no standing
      rule replaces this yet).
- [ ] Post links the repo, shows truncated identifiers only, and
      makes no claim beyond §1.
- [ ] Descriptor rule (§7): the post's first use of Fiador
      carries "human-backed attestation for Discord bots"; the
      name never appears naked in any launch surface's first
      use (README, page headings, badge-adjacent copy, listing
      copy are checked for the same in the trademark/claims
      read above).

Standing, after launch:

- [ ] Narrative update at every arc close in the repo
      (`docs/narrative/` + `CHANGES.md`), per estate doctrine.
      Commit + push need Nic's go each time until he sets a
      program-level rule.
- [ ] Retest on change: any change to verification logic re-runs
      the full fixture set + the §9 live steps it touches, and
      `docs/verification.md` gains a new dated entry.

## 11. Open decisions — Nic's, routed through the coordinator

These stay open in this design. The build does not silently settle
any of them; where a default was needed to write the design, the
spec's recommendation is used as a placeholder and flagged.

| # | Decision | Options / recommendation | Needed by |
|---|---|---|---|
| 1 | Whether anything beyond the operator display name links the human to Nic publicly | Narrowed Oct 25, 2026: the display-name part is settled (resolved, below — Nova's payload names him as operator, §3.1.1). What remains open is any further linkage: README/demo copy stating that the human behind the hash is Nic, or cross-project use of the same hash as his identifier. Recommendation (spec): no for v1; "a unique human" is the claim being demonstrated. The hash-only settlement already caps the exposure either way | §9 step 1, §7 copy |
| 2 | Package names (npm / PyPI) | `fiador` on both (checked free Oct 25, 2026); the exact scoped/unscoped forms are settled at publish time, and availability is re-checked then, as with the repo name. Publishing itself is a separate launch act gated in §10 | First publish |
| 3 | Registry hosting mirror | Settled in practice by the hosting posture (Nic, Oct 26, 2026): the repo file stays canonical (§3.4) and the mirror serves from the same Vercel posture as the other Fiador web surfaces (§6.4). Any static host serving the file byte-for-byte satisfies the contract if posture ever changes | First public verify surface |
| 4 | Hosting cost beyond hobby scale | Standing cost watch (§6.4): the serving/cost picture returns to the coordinator as a decision item with real numbers when usage outgrows hobby scale; not silently absorbed. No threshold is pre-set in this design — the first real traffic data sets it | When traffic data exists |

Decision 1 is the spec's one remaining open item. Decisions
2–3 surfaced during this design and are recorded here rather
than settled. Repo creation itself is not a table row: it is a
go, not a preference, and it has not been given (§10).

Resolved, recorded so nobody re-opens them, and deliberately
not rows above because the table is only for what is still open:

- Which repo is first, and where the verify core lives. Nic
  chose W1 as the first repo with W0 folded in as its verify
  package (Oct 25, 2026). In the header and §4.0.
- Repo and project name. Fiador (Nic, Oct 25, 2026, via the
  coordinator), superseding the same day's earlier pick of
  `human-backed`. Fiador is the Spanish/Portuguese legal term
  for the guarantor who stands surety for another — the name
  states the protocol's claim in one word. It carries no World
  mark and does not imply endorsement. Availability checked
  Oct 25, 2026: the repo was renamed on GitHub to
  `niclydon/fiador` and verified live from this seat (the old
  URL redirects); `fiador.org`, npm `fiador`, and PyPI `fiador`
  all free at check time. "human-backed" remains descriptive
  prose where plainly generic (the claim, the Discord role
  label), per the W1 spec's copy; the project name, package
  names, slash command (`/fiador`), and badge branding are
  Fiador. Descriptor rule (Nic, Oct 25, 2026): Fiador never
  appears naked in public copy; on first use in every surface
  it travels with "human-backed attestation for Discord bots"
  (§7). One cryptographic consequence, recorded here because
  it must not drift: the Discord profile's canonical signing
  prefix is `fiador-discord-attestation:v1` (§3.2) — safe to
  fix now because no attestation has been signed under the old
  prefix (§9 has not run); after the first signed attestation
  exists, the prefix is frozen like any other format constant.
- Licence. Apache-2.0 is the program default for the whole
  World Program, including this repo (Nic, Oct 25, 2026, via
  the coordinator, and recorded in the portfolio). Applied in
  §§7, 8, and 10: the repo ships the full Apache-2.0 text in
  `LICENSE`, the verify package's manifests carry
  `Apache-2.0` as their licence field, and no MIT alternative
  remains anywhere in this design. This supersedes the W1
  spec's "MIT or Apache-2.0, Nic picks at repo creation" line;
  the pick has been made, at program level.
- Operator display name. Optional field, off by default
  (Nic, Oct 25, 2026, via the coordinator). The protocol
  default is name-free and no operator is ever required to name
  themselves; the name is self-asserted under the operator's
  signature and verifiers display it only when present.
  Specified in §3.1.1. Nic's own fleet opts in — Nova's
  attestation carries `operator_display_name: "Nic Lydon"` —
  because his bots already operate publicly as his.
- Deployment model. Self-host only for v1, plus the static
  verify page (Nic, Oct 25, 2026, via the coordinator). No
  project-run hosted verifier bot (and no hosted badge
  instance) in v1; the reference bot is a self-host package,
  each adopting server running its own instance under its own
  Discord application and bot token; the static page performs
  the no-install check. A hosted instance is a possible v2
  addition under a future decision. Specified in §5 and
  checked in §10; the §10 public/private gates stand unchanged.
- humanId disclosure. Hash only (Nic, Oct 25, 2026, via the
  coordinator). Public attestations carry the hash under the
  construction §3.3 specifies —
  `hex(sha256(utf8("w0-human-v1:" + humanId)))` over the
  canonical text form — and the full humanId appears in no
  public material: payloads, registry entries, badge and verify
  pages, fixtures, screenshots. Verifiers resolve the full
  value privately via the live AgentBook lookup from the wallet
  address. Settled into the format in §§3.1 and 3.3 (disclosure
  pinned to `hash`, hash field required, no raw field exists)
  and enforced in §10. This supersedes the spec/design framing
  of raw disclosure as an operator election.
- Credit model. Name stamp plus house visual style, no product
  brand (Nic, Oct 25, 2026, via the coordinator). Specified in
  §8.1 and checked in §10: `LICENSE` copyright line, `NOTICE`
  attribution, author fields in package metadata, the README's
  "Created by Nic Lydon" author block, and Nova Glass styling
  for the banner, verify page, and README header from the
  approved visual assets, with attribution wording that never
  implies World endorsement.

## 12. Ordered build steps

Follows the spec's build order, refined against §§3–6. Each step
ends with its tests green and, where it touches live state, a
dated entry in `docs/verification.md`.

Sequencing under the program direction (portfolio, Oct 25,
2026): ship order outranks polish order. The steps below are a
dependency order, but the milestones they serve are, in order:
(1) DEMO — a demo-able Fiador: the package path exercised end
to end in Nic's guild (§9 steps 1–5), the static page checking a
real attestation, the badge rendering real states, and the
link preview (§6.4): a `/v/` link posted in a channel whose
preview card itself carries the verdict — the demonstration
moment the surface exists for, since it is how a stranger in
someone else's server meets Fiador. Work that
does not unblock the demo waits, however elegant. (2) REGISTRY
PRESENCE — a real listing in World's official AgentBook
registry for the Fiador attestation/verification surface, with
listing copy and demo links prepared as build artifacts of this
workstream (listing copy follows the §7 descriptor rule: Fiador
travels with "human-backed attestation for Discord bots" on
first use; the listing mechanics are verified against World's
current process when the milestone opens; nothing here assumes
them). The public verify MCP's listing (§2, W0's spec) is a
distribution artifact in the same family and ships in this
milestone, not the demo one: the demo proves the verification;
this milestone puts it where agent builders actually look.
(3) POLISH — everything else: visual iteration beyond
the approved asset round, docs depth, extra examples. Within
the program's sequencing, Fiador's job is to be the working
public demonstration; this workstream's effort is weighted
accordingly, and a polish
item never displaces a demo or registry item in a build order
dispute.

0. Prior-art check, re-run (quality bar item 0, Nic-direct
   Oct 25, 2026, standing for the whole program). Before any
   build starts, search: World's docs and packages, the
   AgentBook registry, npm/PyPI, GitHub, the MCP registries,
   and the adjacent field — for anything that already does
   what Fiador does, in whole or in load-bearing part.
   Founding instance, cited not redone: the Oct 25, 2026
   whitespace research (full report:
   `~/workspace/research_notes/world-agentkit-use-cases-whitespace-20261025-2344/report.md`),
   which found the official AgentBook registry holding five
   services and no public implementation for Discord/messaging
   attestation — the verified-empty category this project
   builds in. The field moves, so the check re-runs at build
   start rather than inheriting October's answer: findings go
   into a dated prior-art record in the repo's docs (what was
   found, where, when, and its adoption signals — usage,
   maintenance, uptake — not mere existence). If the re-run
   finds an in-use equivalent, building anyway is a conscious,
   evidence-backed call recorded in that same record (the
   existing thing is dormant, proprietary where openness is
   the point, or materially different in shape); reinventing
   an in-use wheel by accident is a defect, and the build does
   not start until the record exists.
1. The verify package, core first (§4): re-verify the chain
   facts (network, contract, `lookupHuman` signature) against
   current World docs and record the check; prove the SDK
   null/error behaviour (§4.3 build task); then fixtures +
   canonicalisation vectors (§4.4) and the core API (§4.1)
   seeded from the playground's AgentBook lookup, with the
   package-boundary CI checks (§4.0) and the standalone-build
   job (§4.8) green from this step onward — the boundary is
   cheapest before anything depends on breaking it. The
   Discord subpath (§4.6) lands at the end of this step.
   Coordination checkpoint: §13's divergence log is agreed with
   the W0 chat through the coordinator before this step starts,
   because the package is the one artifact both chats own.
2. Static verify page (§6.1) on the bundled package, with the
   §6.2 badge assets wired in.
3. Python port (§4) to fixture parity with TS.
4. Reference signer CLI (§3.2) + publish-your-attestation
   walkthrough (§7) — needed before any end-to-end test can
   produce a real attestation.
5. Verifier bot (§5) with role sync, fetch guards, and the
   `/attest` flow; badge service (§6.3, W0 spec §4) alongside it.
5a. Link preview endpoint (§6.4) on the badge-service
   operational family: id resolution against the registry,
   crawl-time verification through the package, dynamic OG
   card rendering from the §6.2 assets, and the two failure
   cards (not found / could not check). Demo-milestone work:
   it is the surface the guild demonstration is performed
   through (posting the link IS the demo), so it lands before
   step 7's test, on a staging host until the canonical
   domain is live.
6. Registry, README, examples, threat model, CI incl. secret
   scan (§§3.4, 7, 8, 10).
7. Nic's-guild end-to-end test (§9), adversarial review (§10),
   launch checklist (§10), then — and only on Nic's go — repo
   creation and first public push, in that order.
8. Community guild pitch (§9 step 6), on Nic's go, with the
   working demo as evidence.

No step before 7 creates a repo, pushes publicly, changes a
Discord server outside Nic's guild test in step 7's test phase,
or sends anything outward.

## 13. Coordination with W0 — divergence log

The W0 spec (`~/workspace/world-program/w0-verify-core/SPEC.md`)
and the first revision of this design were written in parallel
and diverged in six places. Per the coordinator's instruction,
divergences route through the coordinator; this log is the W1
side's record for that conversation. Items marked RESOLVED were
settled in this revision by adopting the W0 position, because
the package is W0's spec and one program cannot carry two
answers to the same protocol question. Items marked OPEN need
the coordinator (and, where stated, the W0 chat) to close them;
the build does not start on the package until D1–D4 are closed
in writing in both documents.

- D1, human hash. RESOLVED. First W1 revision: `keccak256` of
  the humanId bytes. W0 spec §3.5: `sha256('w0-human-v1:' +
  humanId)`, hex. This revision adopts W0 (§3.3, §4.1). One
  hash algorithm for the whole program; W1's dedupe use case
  works identically under either, so the cost of adopting is
  zero and the cost of diverging is permanent.
- D2, canonical form and signing string. RESOLVED. First W1
  revision: all keys sorted (JCS subset) plus a
  `fiador-discord-attestation:v1` prefix line. W0 spec
  §3.2: payload keys in defined order, `extra` keys sorted, the
  canonical string alone is the message, signatures typed
  `eip191 | eip1271` with `verifyMessage` handling both. This
  revision adopts W0 (§3.2). Recorded cost: W1 loses its
  protocol-name prefix; subject binding inside the signed
  payload carries the anti-replay weight instead (§3.2 note).
- D3, result shape and platform floor. RESOLVED. First W1
  revision: boolean `valid` result, Node 18+. W0 spec §3.0–3.1:
  five-state `VerificationStatus`, evidence block, Node 20+.
  This revision adopts W0 (§4.1); the boolean survives only as
  a documented consumer mapping (`valid === (status ===
  'verified')`, §4.6). The richer shape is what §5.5's revoke
  asymmetry and W4's page both require, so this was not a close
  call.
- D4, resolver-null status. OPEN, coordinator decision (it is
  the W0 spec's own Q3). When a subject has no attestation at
  all, W0 provisionally proposes status `unknown` plus a new
  failure code `attestation_not_found`, with the badge rendering
  it as unverified. W1's surfaces need the distinction either
  way (§4.2 note): the bot logs "no attestation found" on join,
  and the guild pitch must not describe an operator who never
  attested as having failed a check. W1 position: adopt the
  W0 provisional answer, and give it its own plain-language
  sentence, distinct from every failure sentence.
- D5, `verifySignedMessage` export. OPEN, W0 chat to agree.
  This revision proposes one export beyond the W0 spec's
  closed list, because W3's seal verification needs a
  recovered-signer check over its own payload (§4.7). If the
  W0 chat prefers, the same need is met by documenting W3's use
  of `verifyAttestation` with a W3 subject type and its seal
  fields in `extra` — but that forces W3's format into the
  attestation envelope, which its spec does not want. W1 has
  no stake beyond the package staying the single home of
  signature verification.
- D6, Python port ownership. OPEN, coordinator to confirm
  (W0 spec Q7). W1's spec lists `verify-py` as a W1 repo
  deliverable; the W0 spec ships no Python in its v1 and asks
  whose item the port is. This revision houses the port in the
  W1 repo's package set either way (§4.5); the open part is
  only whether the W0 chat co-owns its parity standard or
  reviews it. The fixture-parity bar does not change.

Standing coordination rule from this revision forward: the
package's API, canonical form, hash, and status model are
changed only by agreement between this chat and the W0 chat,
recorded in both documents and surfaced by the coordinator.
Consumer needs (W2–W6) enter as proposals through §4.7's rule,
never as edits made unilaterally in a consumer's code.
