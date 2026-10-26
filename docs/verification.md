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
