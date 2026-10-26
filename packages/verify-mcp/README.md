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

# streamable HTTP (self-hosted; stateless)
VERIFY_MCP_PORT=8787 npx @fiador/verify-mcp --http
```

Configuration is environment only: `VERIFY_RPC_URL`,
`VERIFY_CONTRACT_ADDRESS`, `VERIFY_TIMEOUT_MS`,
`VERIFY_BADGE_BASE_URL`, and `VERIFY_REGISTRY_FILE` (a JSON document
mapping `"subjectType:subjectId"` to signed attestation objects,
loaded at startup). The server ships no authentication of its own;
put access control at your gateway if you need it.

Both transports run the same tool implementation and are tested for
byte-equivalent results.

Apache-2.0. Created by Nic Lydon.
