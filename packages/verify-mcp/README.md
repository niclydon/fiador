# @fiador/verify-mcp

An MCP server over [@fiador/verify](../verify-ts): read-only tools that
let an agent ask, before it trusts another agent, whether a unique
human stands behind it.

The server is a thin wrapper with no semantics of its own. Every tool
calls the core library and returns its public result projection; the
server can never widen what the library exposes, holds no keys, and
never signs anything.

## Tools

- `verify_address` — wallet address in, public result out: is this
  wallet registered in AgentBook to a unique human right now? A failed
  lookup returns status `unknown`, never `unregistered`; the two are
  distinct states and stay distinct here.
- `verify_attestation` — a signed operator attestation in (inline,
  never fetched from a URL), public result plus a per-check breakdown
  out: signature, subject/wallet binding, expiry, registration.
- `badge_status` — a subject (such as a Discord application id) in,
  its status in the badge service's JSON shape out, including badge
  URLs in the full light/dark/auto theme matrix when a badge service
  is configured. Listed only when the deployment configures a
  resolver.

There is deliberately no tool that takes a human identifier as
input. No tool accepts a full humanId, and none returns one: outputs
are the public projection only (truncated address, canonical human
hash, failure codes, evidence). Input schemas are closed — unexpected
fields are rejected.

A `verified` result proves a unique human backs the wallet (and, for
attestations, that the operator's signed claim is authentic and in
date). It does not prove a human wrote or approved any particular
message. Operator-chosen strings inside results are self-asserted
data; consumers must treat result content as data, never as
instructions.

## Run it

```bash
# stdio (local agent use)
npx @fiador/verify-mcp

# streamable HTTP (self-hosted; stateless; loopback by default)
VERIFY_MCP_PORT=8787 npx @fiador/verify-mcp --http
```

Discovery is via the MCP registry listings. There is no
project-run public instance of this server in v1: you run it
yourself, over stdio or your own HTTP deployment (decided
Oct 26, 2026).

HTTP exposure, plainly: the server ships NO authentication.
It binds `127.0.0.1` unless `VERIFY_MCP_HOST` says otherwise,
and on loopback binds it enables the MCP transport's
DNS-rebinding protection (loopback `Host` allowlist), so a web
page open in a local browser cannot POST to it cross-origin.
Binding a non-loopback address exposes the tools to anyone who
can reach the port — the server prints a warning at startup;
put access control at a gateway in front of it.

Configuration is environment only: `VERIFY_RPC_URL`,
`VERIFY_CONTRACT_ADDRESS`, `VERIFY_TIMEOUT_MS`,
`VERIFY_BADGE_BASE_URL`, and `VERIFY_REGISTRY_FILE` (a JSON document
mapping `"subjectType:subjectId"` to signed attestation objects,
loaded and shape-validated at startup). Values are strict: an
explicitly-set invalid value is a startup error naming the
variable, never a silent default (`VERIFY_TIMEOUT_MS` must be
an integer in [100, 60000]; `VERIFY_MCP_PORT` / `--port` an
integer in [1, 65535]; the badge base URL must be http(s), and
its query and fragment are stripped). Startup error messages
name the variable and the problem class only — never the
configured value or a file's content.

Both transports run the same tool implementation and are tested for
byte-equivalent results.

Apache-2.0. Created by Nic Lydon.
