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
