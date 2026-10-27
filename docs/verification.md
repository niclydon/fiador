# Verification log

Live-run evidence, recorded with dates and dependency versions. A
live pass is a fact about a day and a dependency version, not a
permanent label; retest on change re-runs the full set (unit,
fixture, service, then live). Entries record status and the
canonical hash at most — never a full human identifier.

## 2026-10-26 — verify core 0.1.0 and verify MCP 0.1.0

Environment: Node v22.23.4, viem 2.57.11, @modelcontextprotocol/sdk
1.32.2, TypeScript strict. AgentKit SDK examined for the reader
decision: @worldcoin/agentkit-core 0.2.1.

- Unit and fixture suites: `@fiador/verify` 32 passed (3 live tests
  skipped by default), `@fiador/verify-mcp` 8 passed. Fixtures are
  synthetic and deterministic; the suite asserts the committed
  vectors match a fresh generation.
- Reader decision, evidenced: the SDK's
  `createAgentBookVerifier().lookupHuman` wraps its contract read
  in `catch { return null }`, collapsing RPC failure into
  non-registration. The core therefore reads the AgentBook contract
  directly with viem (same contract, same ABI), preserving the
  `unregistered` vs `unknown` distinction.
- Live, against the real AgentBook contract on World Chain:
  - The program's dedicated wallet (truncated `0x21BD…A14Bc`,
    registered 2026-10-26) → `verified`, canonical hash
    `7bf4573c68a6…` (prefix recorded; full hash is a public-shape
    value by design but is not republished here).
  - A known-unregistered address → `unregistered` +
    `not_registered`.
  - A dead RPC endpoint → `unknown` + `lookup_failed`, never
    `unregistered`.
- Live, through the MCP server (both transports): `verify_address`
  for the same wallet → `verified` with the same hash over stdio
  and over streamable HTTP; tool outputs scanned — no raw humanId,
  no `humanId` key, no full address.

## 2026-10-26 — founding attestation published (DESIGN §9 step 1)

- Signer CLI (@fiador/signer, PR #4, merge 63fee3b) signed the
  founding attestation for the Nova Discord application
  (1561422752521396254) with the program wallet (truncated
  0x21BD…A14Bc). Payload hash
  8bfeb9f9182de3ce63cdf42bdff941277250d96089982c65f0f97761f195a031;
  issued 2026-10-26, expires 2027-01-24.
- Published (PR #6, merge 6a11c07): registry/registry.json carries
  the founding entry; verify-page/ hosts the attestation.
- Hosting: Vercel project fiador (production deployment
  dpl_5egAYCPqBo93qMPdmDTb1uxKox72); fiador.org and
  www.fiador.org (308 to apex) attached; Cloudflare DNS A @
  76.76.21.21 and CNAME www cname.vercel-dns.com, both DNS-only.
- Live evidence, fetched back from the public URLs:
  https://fiador.org/attestations/nova.json returns 200,
  byte-identical to the signed file (sha256 ad1c0e5e…), and the
  signer verify command against the fetched copy returned
  status verified, checkedAt 2026-10-26T10:41:40Z, humanHash
  7bf4573c68a6… matching the registration record above.
  https://fiador.org/registry.json is byte-identical to the
  repo registry. §9 step 1 is complete; steps 2-5a remain.

## 2026-10-27 — privacy and support static release candidate

Prepared locally from the verified deployed site commit `4f366af`.
At that local checkpoint, no preview, PR, or production deployment had
been made. The build publishes only the eight files listed in
`docs/narrative/2026-10-27-static-privacy-support-release.md`.

- `node scripts/build-pages-static.mjs` and
  `node --test scripts/static-web.test.mjs`: 3 tests passed. The
  output allowlist has no `/verify/`, `/v/`, or `/api/preview` route,
  function, or rewrite. Local HTTP returned 200 for `/`,
  `/privacy/`, `/support/`, `/registry.json`, and the published
  attestation, and 404 for those three unshipped routes.
- Chromium screenshots inspected at 1280 × 800 in light mode and
  390 × 844 in dark mode for both new pages. Layout and text fit
  without clipping; the local theme control rendered in both modes.
- Gitleaks 8.30.1 manual full-tree scan: five pre-existing synthetic
  test-fixture findings (three Discord ID examples, two generic API
  key examples), zero in changed paths. All-refs git-history scan:
  fifteen findings of the same fixture classes, zero in changed
  paths. No scan finding is being dismissed as a real credential.
  A private roster comparison found no full identifier or
  12-character fragment in changed files. The already published
  attestation's protocol-required wallet and hash data remain
  byte-identical and are the only private-roster matches in the
  pre-existing static site.
- Live `fiador.org` still returned 404 for `/privacy/`,
  `/support/`, `/verify/`, `/v/example`, and `/api/preview` at this
  checkpoint. Its `/registry.json` and founding attestation
  returned 200 and matched this candidate's bytes: SHA-256
  `65b4d5f9cff45bbf967eb4248348bac1a443ec725ac9571cfdf71b47b5e006aa`
  and `ad1c0e5e2ab9ea3b78aebd5c2f1b3905392b86a96bc10246264e3a6eba4cce6b`,
  respectively. This is a baseline comparison, not a release smoke.
- Draft PR #26 targets the retained deployed-baseline branch for a narrow
  review diff. The protected preview from `54bb3cd` reached READY:
  `/privacy/` and `/support/` returned 200, while `/verify/`,
  `/v/example`, and `/api/preview` returned 404. Preview registry and
  attestation response bytes and `Access-Control-Allow-Origin: *`
  matched the existing production deployment. No production deployment
  has been made from this candidate.
