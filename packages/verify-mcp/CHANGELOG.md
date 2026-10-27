# Changelog

## 0.2.0 — 2026-10-26

The §7.5 adversarial-review fix pass (companion to
@fiador/verify 0.3.0; requires `^0.3.0`).

- HTTP transport: the handler no longer pre-reads the request
  body. The raw request goes to the SDK transport; a declared
  Content-Length over 1 MB is refused with 413 before any byte is
  read, and the SDK's `maxRequestBodySize` enforces the same cap
  while streaming chunked requests, before JSON parsing. A 30 s
  server request timeout bounds body arrival (B4). Routing is on the URL pathname, `/health` is GET-only,
  and the catch path always ends or destroys the response (m7).
  The wiring lives in `src/http.ts` so integration tests exercise
  the real handler.
- HTTP binds `127.0.0.1` by default (`VERIFY_MCP_HOST` overrides,
  with a startup warning for non-loopback binds) and enables the
  SDK transport's DNS-rebinding protection with loopback
  allowedHosts on loopback binds (M15). Ports are strict:
  `VERIFY_MCP_PORT` / `--port` must be an integer in [1, 65535]
  (M16).
- `verify_attestation`: duplicate JSON keys at any depth in a
  string document are detected by a strict parser and return the
  `malformed_attestation` domain result instead of verifying a
  last-wins collapse (M10). An oversize document returns the
  spec'd domain result (invalid + `malformed_attestation`,
  checks all `not_checked`, structured content present) instead
  of an `isError` tool error (M11). Subject expectations carry
  the same length caps as `badge_status` (m4).
- The `checks` projection no longer fabricates stage results:
  on an `unknown` result, stages the failure codes cannot vouch
  for report `not_checked` (M5), including date failures combined
  with ambiguous ERC-1271 lookup failures. A lifetime failure reports
  `expiry: 'lifetime_invalid'` with signature and binding stages
  intact (M6).
- Configuration fails with fixed, sanitised startup messages:
  a malformed registry file, a bad contract address, or an RPC
  URL the core rejects names the variable and the problem class
  only — never file content, configured values, or parser text
  (M14). `VERIFY_TIMEOUT_MS` must be an integer in [100, 60000];
  an explicitly-set invalid value is a startup error, not a
  silent default (M16). The registry file's shape is validated
  at startup and its map keys are encoded unambiguously (m5).
  The badge base URL is validated at startup (http/https only,
  query/fragment stripped) and `.` / `..` subject segments are
  rejected before badge URL construction (m6).
- Tool handlers are guarded: an unexpected throw returns a fixed
  `internal error` tool error, never the underlying message
  (M12).

## 0.1.0 — 2026-10-26

Initial implementation of the SPEC section 11 MCP server over
@fiador/verify: `verify_address`, `verify_attestation` (with the
per-check breakdown), and `badge_status` (listed only when a
resolver is configured), over stdio and stateless streamable
HTTP, with closed input schemas and the public projection as the
only output shape.
