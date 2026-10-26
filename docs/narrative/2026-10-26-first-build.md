# 2026-10-26 — The first build: two lanes, one core

Fiador had been a design for a day — a complete one, in
`docs/DESIGN.md`, but a design. The question the overnight
directive of Oct 26, 2026 answered was whether the parts of
the product that did not depend on each other had to wait for
each other. They did not, and this is the record of building
them in parallel and merging them into one tree.

## The directive and the split

Nic's overnight instruction, relayed through the World
Program coordinator, was to keep pushing on agent-owned steps
without waiting for him: for W1, build the parts of Fiador
that do not wait on the W0 verify core — the verifier bot
scaffold and the link-preview endpoint — against the W0
interfaces exactly as the W0 spec defines them, stubbing at
the interface boundary where the core had not yet landed, and
saying so. Anything needing Nic, a funded wallet, DNS, or a
deploy was to be documented and stacked for the morning.

At almost the same hour, the W0 lane stopped spec'ing its
core and built it. Neither lane waited for the other; the
spec was the contract between them. That is the arrangement
this narrative exists to record, because it worked: two
branches, written independently against one interface
document, merged the same morning with the overlap confined
to exactly the files both lanes had reason to touch.

## What W1 built (branch build/w1-scaffold)

Three packages, in a working copy first and then the repo:

- `packages/verify-ts` (the stub). A faithful implementation
  of the W0 spec's §3 surface — `createVerifier`,
  `verifyAddress`, `verifyAttestation`, `resolveStatus`, the
  internal/public result split, the canonical form, the
  humanId hash — with the two genuinely-missing pieces left as
  injected dependencies whose defaults fail closed: the
  default signature verifier verifies nothing, and a verifier
  built without an AgentBook reader reports every lookup
  `unknown` rather than guessing. 24 tests. This package was
  always understood to be a placeholder; its job was to make
  the consumers real and to prove the interface was buildable
  as specified. It found one spec-level question (the
  disclosure pin, logged as D7 in the design's §13) and one
  naming mismatch, both recorded below.
- `verifier-bot`. The self-host reference bot of DESIGN §5:
  `/fiador`, `/verify-agent`, `/attest`; SQLite guild config,
  bindings, and a `check_log` that records every check;
  Human-backed role sync on the design's asymmetry — revoke
  on invalid, expired, or unregistered, never on unknown, with
  one retry and a warning before a second consecutive unknown;
  embeds built only from the public projection, with the
  descriptor line in the footer. Patterns for guild config,
  role assignment, and error handling were informed by the
  upgraded world-id-discord fork that had proved the World ID
  verification path live the same night; its IDKit user-proof
  flow was deliberately not inherited, because Fiador verifies
  operator attestations, a different claim. 26 tests.
- `link-preview`. The §6.4 surface as one framework-free
  handler: `/v/<short-id>` resolution against the published
  registry with content-derived ids, tombstone entries
  matching by payload hash without any fetch, crawl-time
  verification through the core, a dynamically rendered
  1200×630 OG card in the badge family's state treatments, the
  two named failure cards (not found at HTTP 200 with full
  meta; could-not-check with `no-store`), and browser
  click-through to the verify page with the attestation
  prefilled. Platform coupling is two thin Vercel adapter
  files, per the hosting posture's portability constraint.
  16 tests.

The humanId rule was treated as a test property, not a
comment: each package's suite deep-scans its public outputs
and proves the synthetic fixture humanId, the full wallet
address, and (in the preview's case) even the literal key
name appear in none of them.

## What the build caught

Two specification collisions surfaced only because code had
to commit to one reading:

- The fetch guard. The bot's build brief specified
  redirect-following with re-vetting and a 256 KiB body cap;
  DESIGN §5.4 specifies no redirect following (a 3xx is a
  failed fetch, because the target was never vetted) and
  64 KiB. The design governs. The guard and its tests were
  aligned to §5.4 during integration, including §5.4's softer
  content-type rule (JSON expected, parse decides).
- The canonical form. W0 found that DESIGN's decisions
  summary still described a `fiador-discord-attestation:v1`
  signing prefix while the normative §3.2 and the D2
  resolution had adopted the W0 form — the serialised payload
  alone is the message, no prefix. The summary and CHANGES.md
  were corrected (commit `ed6ee91`) before any attestation
  existed to be signed under either form, which is the only
  reason the fix was free.

## What W0 built (branch w0/verify-core-build)

The real core: `packages/verify-ts` implementing the spec
with the SDK-backed AgentBook reader, viem signature
recovery for both EIP-191 and ERC-1271, fixture vectors
pinning the canonical form and the hash, and a live test that
proves an AgentBook verification against the real contract.
32 tests. Beside it, `packages/verify-mcp`: the §11 MCP
server over the core — three read-only tools, no semantics of
its own, the humanId rule as a server invariant — with 8
tests including transport parity between stdio and HTTP.
During the same night Nic froze the MCP's two open questions:
M1, no project-run public HTTP instance in v1; M2, the
`badge_status` tool ships in v1 with badge URLs honestly
omitted when no badge base URL is configured (commits
`642bafc`, `79dbda7` on that branch).

## The merge (Oct 26, 2026, on Nic's /ship go)

Order was chosen to make the surviving implementation
obvious: W0's branch merged first, cleanly, since both
branches stood on the same base (`53142b2`). The W1 branch
was then resolved onto the new main:

- `packages/verify-ts`: W0's implementation replaces the W1
  stub wholesale, as the coordinator's reconciliation had
  pre-agreed. The stub's tests go with it; the core's 32
  tests are the package's suite now.
- One export-name mismatch, predicted in W1's merge note the
  previous hour: the stub exported the canonical helper as
  `canonicalAttestationBytes`; the core exports
  `canonicalAttestationMessage`. W1's consumers were adapted
  to the core's name.
- The short-id helper the stub carried (`attestationShortId`)
  has no counterpart in the core, correctly: short ids are a
  §6.4 link-preview concern, not a core concept. It moved into
  `link-preview`, computed over the core's canonical bytes.
- Root `package.json` and `package-lock.json`: workspaces and
  test scripts unioned across all four packages; the lockfile
  regenerated on the merged tree rather than hand-merged.
- `CHANGES.md` and `.gitignore`: unioned.

After the merge, the full root suite runs on main itself —
not on either branch — and the merged state is verified
against the remote before the branches are deleted. The
numbers from that run are the ones reported with the ship;
branch-level numbers (66 W1 tests, 40 W0 tests) are history,
not the headline.

## What remains open, honestly

- D7 (DESIGN §13): the Discord profile's disclosure pin
  versus the core's generic `'hash' | 'none'` model. The
  build follows the generic core; the pin, if the coordinator
  upholds it, is a small consumer-side check. Undecided, not
  hidden.
- The demo (§9 of the design) still waits on what it always
  waited on: the program wallet's registration tap, DNS and
  hosting for fiador.org under the Vercel posture, and a live
  Discord run of the packaged bot — tonight's live proof ran
  on the upgraded fork bot, not on this package.
- The link preview's `og:image` is SVG; a rasterisation
  adapter is a deploy-time task, recorded in its README.
- Formal adversarial review remains a launch gate (§10)
  before any public identity claim or deploy; this merge
  publishes code to an already-public repo and makes no new
  public claim.

See `CHANGES.md` for the chronological diff summary.
