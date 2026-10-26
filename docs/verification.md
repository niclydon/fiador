# Verification log

Live-run evidence is recorded with dates and dependency versions. A
live pass is a fact about a day and a dependency version, not a
permanent label; retest on change re-runs the full set (unit,
fixture, service, then live). Public narrative entries identify the
dedicated program wallet by role and record methods and status without
wallet or human-hash fragments. The signed public attestation retains
the wallet address required by the protocol.

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
  - The dedicated program wallet (registered 2026-10-26) returned
    `verified`.
  - A known-unregistered address returned `unregistered` +
    `not_registered`.
  - A dead RPC endpoint returned `unknown` + `lookup_failed`, never
    `unregistered`.
- Live, through the MCP server (both transports): `verify_address`
  for the dedicated program wallet returned `verified` over stdio
  and streamable HTTP. Tool outputs were scanned: no raw humanId,
  no `humanId` key, and no full address.

## 2026-10-26 — founding attestation published (DESIGN §9 step 1)

- Signer CLI (`@fiador/signer`, PR #4, merge 63fee3b) signed the
  founding attestation for the Nova Discord application using the
  dedicated program wallet. It was issued 2026-10-26 and expires
  2027-01-24.
- Published in PR #6 (merge 6a11c07): `registry/registry.json`
  carries the founding entry; `verify-page/` hosts the attestation.
- Hosting at publication: Vercel project `fiador`; `fiador.org` and
  `www.fiador.org` (308 to apex) attached, with Cloudflare DNS.
- Publication fetch-back: `https://fiador.org/attestations/nova.json`
  returned 200 and matched the signed repository file byte for byte.
  The signer verified the fetched copy with status `verified` at
  2026-10-26T10:41:40Z. A read-only recheck on 2026-10-26 still found
  the public attestation byte-identical to the repository copy.
- The public `https://fiador.org/registry.json` returns 200 and lists
  the founding entry. A 2026-10-26 read-only comparison found that
  the live entry matches the repository entry on its present fields,
  but omits the repository's `payload_hash` field. The live and repo
  registries are therefore not byte-identical. Reconcile and recheck
  this deployment drift with the next production web release.
- On the same read-only check, the site root returned 200 while
  `/verify/` and a test `/v/` URL returned 404. §9 step 1 publication
  is complete; the page and preview live tests in steps 2–5a remain.

## 2026-10-26 — protected web preview route smoke

- Source checkout: Fiador main `3c798ba` (before documentation-only
  PRs #20 and #21). `npm ci`, `npm run build:web`, typecheck, and the
  full local test command passed. The Vercel CLI linked the existing
  `niclydon/fiador` project and created preview deployment
  `dpl_Hj4kKEnVNPdiFCa212gW5pfQArhf`, READY with Vercel
  Authentication and no production alias.
- Authenticated fetches on that preview returned 200 for `/`,
  `/verify/`, `/registry.json`, and the published attestation. The
  registry and attestation bytes matched the local web build.
  Both JSON responses included `Access-Control-Allow-Origin: *`;
  browser cross-origin fetch remains untested.
- The synthetic `/v/` link returned a 302 from a browser user agent
  back to `/verify/` on the same preview. A crawler user agent got
  200 Open Graph HTML and its SVG card returned 200. A link for the
  already published attestation rendered **Claim unconfirmed** in
  the crawler page and card. Dynamic page, redirect, and card
  responses carried `Cache-Control: no-store`; rendered HTML and
  SVG contained no full wallet or human-hash value.
- This was a protected route smoke, not a real browser World Chain
  check, Discord unfurl, application-control witness, or public
  release. Production `fiador.org` still served an older deployment
  with `/verify/` and `/v/` returning 404. Browser CORS/RPC behavior,
  Discord unfurl and app-control evidence remain launch gates.

## 2026-10-26 — local browser check with the live attestation and chain

- Built Fiador main `ebdbd3d` with `npm run build:web` and served its
  ignored `public/` tree on loopback. Chromium loaded `/verify/` with
  HTTP 200 and checked the founding public Discord application ID through
  the locally served canonical registry.
- The browser fetched the published attestation from `fiador.org` and
  used the page's default `worldchain-mainnet.g.alchemy.com` RPC. There
  were no failed browser requests or page errors. The result was
  **Claim unconfirmed**: wallet signature, signed Discord profile, and
  live AgentBook registration passed; Discord application control was
  not established.
- This establishes that the browser CORS and live RPC path worked from
  a local build at check time. It does not test the protected Vercel
  preview, the still-missing production `/verify/` and `/v/` routes,
  a Discord unfurl, or application control.
