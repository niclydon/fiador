# Changelog

## 0.2.0 — 2026-10-26

The §7.5 adversarial-review fix pass (companion to
@fiador/verify 0.3.0; requires `^0.3.0`).

### Fix pass 3 (re-review 2)

- Arrival deadlines are per REQUEST, not per connection
  (NEW-1): the pass-2 timers armed the headers deadline once
  per connection and cleared it at the first request event, so
  on a reused (keep-alive) connection a second request's
  header phase was bounded by nothing, and its total deadline
  started only once its headers had fully arrived. The factory
  now re-arms the headers deadline whenever a socket goes idle
  after a response, and measures the total deadline from when
  each request began arriving. Regression probes pin both
  legs: a header drip on a reused connection dies at the
  headers deadline, and a slow header phase consumes the same
  total budget as the body that follows it.
- The `checks` projection takes the registration stage from
  the core's recorded fact (D6, companion to @fiador/verify
  fix pass 3): the core reports whether the step-6 lookup ran
  and how it resolved, so claim-replay / claim-expired /
  claim-failure results — which carry no lookup latency — are
  no longer misreported as `not_checked`, and an expiry
  crossing with a failed lookup reports registration
  `unknown` (D5).

### Fix pass 2 (re-review)

- The body cap is now enforced by the transport alone (B4,
  superseding the note below): the hand-rolled declared-length
  pre-check is removed, so declared and chunked oversize bodies
  alike are refused with the SDK's own 413 JSON-RPC shape.
  Arrival time is bounded by the factory's own per-connection
  timers — a headers deadline (10 s) below a TOTAL request
  deadline (30 s, measured from the connection and never reset
  by arriving bytes). Probing the pinned Node showed its
  built-in headersTimeout/requestTimeout properties do not
  terminate an idle connection or a drip in this build, so the
  factory enforces both bounds itself (and also assigns the
  built-ins, as defence in depth). Probes pin the behaviour:
  2 MiB chunked → SDK-shaped 413; a 1-byte/250 ms body drip
  terminated at the total deadline; a header drip terminated
  at the headers deadline.
- The `checks` projection restores SPEC 11.2's mapping exactly
  (M5): registration is `unknown` when the lookup ran and failed
  and `not_checked` only when the pipeline failed before it
  (proven by the result's status and lookup latency); date
  codes and a bare expired status never count as signature
  evidence when a lookup-failure code is present.
  [Corrected in fix pass 3: the stage is proven by the core's
  recorded registration fact, not by status/latency inference
  (D6).]
- Host handling is normalised (M15): `127.1`, `LOCALHOST`,
  `0:0:0:0:0:0:0:1`, IPv4-mapped forms, and friends are
  recognised as loopback for both the DNS-rebinding decision
  and the non-loopback startup warning.
- Wrong methods on `/mcp` and `/health` return 405 in the
  SDK's JSON-RPC error shape (DELETE `/mcp` no longer 200s),
  `--port N` parses like `--port=N`, and the HTTP factory
  validates its own options (m7/M16). A test spawns the real
  built `main.js` and exercises `/health` and `tools/list`.
- `verify_attestation`'s object form is round-tripped through
  the strict parser (M10): a document that is
  `malformed_attestation` in string form is malformed in object
  form for everything the handler can see. (A `__proto__` key
  on the envelope itself is dropped by the schema library
  before the handler runs — probed against the pinned
  SDK/zod — and is caught only in string form.)
- Registry values are shape-validated at startup (payload,
  signature, signatureType) and whitespace-padded key legs are
  rejected; badge base URL credentials are stripped along with
  the query and fragment (m5/m6).

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
