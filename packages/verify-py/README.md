# fiador-verify (Python)

Verify that a unique human stands behind an agent wallet: AgentBook
registration lookups and signed operator attestations, with a
hash-only public result shape.

This package is the Python parity port of
[`@fiador/verify`](../verify-ts) (the W0 verify core, spec at
`w0-verify-core/SPEC.md` in the world-program repo). It mirrors the
TypeScript core field-for-field with snake_case names (W1 DESIGN
4.1): same check order, same statuses, same failure codes, same
canonical signing form byte-for-byte, same canonical human hash.
Parity is checked in CI against the TypeScript package's committed
fixture vectors (`packages/verify-ts/fixtures/vectors.json`). The
cross-language gate runs the same vectors through both packages and
diffs complete internal and public results, signed-message results,
canonical messages, and hashes. It normalizes measured lookup latency
only. A shape or outcome change in one package fails the gate.

## Install

```sh
pip install fiador-verify        # once published
# From this repo:
pip install -e packages/verify-py
```

Requires Python >= 3.11. Runtime dependencies are deliberately
minimal and mainstream: `eth-account` / `eth-utils` (keys, EIP-191
recovery, EIP-55 checksums, hashing) and `httpx` (raw JSON-RPC
transport). There is no `web3.py`: the port speaks raw JSON-RPC so
that transport failures stay visible as failures instead of being
collapsed into a null result by middleware — the distinction between
"checked, not registered" and "could not check" is the core's reason
to exist (spec 3.1).

The wheel includes `py.typed`. CI installs that wheel in a clean
environment and checks the public return type with mypy.

## Usage

```python
from fiador_verify import create_verifier, to_public_verify_result

verifier = create_verifier()  # direct AgentBook reads on World Chain

result = verifier.verify_address("0x…")
public = to_public_verify_result(result)   # the only public shape
print(public.status, public.human_hash)    # 'verified', '7bf457…'…
```

`verify_attestation(attestation, ...)` checks a signed operator
attestation in a fixed order (shape, subject/wallet binding,
signature, dates, read-only replay, registration, atomic nonce claim)
and returns the same
`VerifyResult`. `resolve_status(subject)` composes the two for
address, attestation, and resolver-backed attested-subject inputs.
`verify_signed_message(message, signature, signature_type,
expected_address=None)` verifies an arbitrary caller-canonicalised
message through the same signature machinery (EIP-191 recovery for
EOAs, ERC-1271 for contract signers, per the signature type the
caller declares); it performs no AgentBook lookup and no attestation
semantics (spec 3.6).

Result types are dataclasses: `VerifyResult` (internal; may carry a
raw humanId only when the verifier was built with
`include_raw_human_id=True`) and `PublicVerifyResult` (the public
projection — no raw humanId, no full address, ever).

Options on `create_verifier(...)` mirror the TS core: `reader`
(an object with `lookup_human(address) -> str | None` that raises on
transport failure), `rpc_url`, `contract_address`, `timeout_ms`
(per-lookup deadline, default 5000), `now` (clock injection),
`clock_skew_ms` (default 60_000; applies to `issuedAt` only, never
to expiry), and `include_raw_human_id` (default False).

A nonce store passed to `verify_attestation` implements a strongly
consistent `has(nonce, wallet) -> bool` read and an atomic
`claim(nonce, wallet, expires_at) -> 'claimed' | 'replay' | 'expired'`.
The store checks its own clock at the write point and never records a
nonce after `expires_at`. Replay is checked before expiry; a fresh
nonce is claimed only after registration succeeds, or when the caller
explicitly disables that check. `InMemoryNonceStore` is a thread-safe,
single-process reference implementation. The verifier claims only
after every uncertain, expired, or unregistered outcome has returned;
there is no release operation. Production replay protection needs a
durable shared store with the same atomic claim behavior. Store errors
and deadlines fail closed as `lookup_failed`; a timed-out claim may still finish in the backend,
so an unknown result is not permission to retry automatically.

The configured RPC is the trust oracle for
registration answers: non-https RPC URLs are rejected at
construction, except loopback endpoints (`localhost`, `127.0.0.1`,
`::1`) where plaintext never leaves the machine.

Reader values must be `None` or a full `0x`-prefixed 32-byte human ID;
other values are `unknown` + `lookup_failed`. The accepted ID is
lowercased before hashing, so letter-case variants of one uint256
yield one hash. ERC-1271 signatures are
limited to 8 KB, and `extra` keys with lone surrogates are malformed.

The synchronous Python verifier bounds in-flight deadline workers to
eight per process. A timed-out collaborator keeps its slot until it
actually finishes; a saturated verifier returns `unknown` +
`lookup_failed` promptly. Callers should configure finite timeouts on
custom readers and resolvers.

Two deliberate Python adaptations, neither of which changes any
verdict:

- The API is synchronous. Lookups, ERC-1271 checks, nonce-store calls, and
  `resolve_status` resolvers run under the deadline on a daemon
  thread. A hung reader, contract check, or resolver yields `unknown` +
  `lookup_timeout`; a hung nonce store yields `unknown` +
  `lookup_failed`, matching the TS core.
- Where the TS core takes an `AbortSignal`, Python takes a
  `threading.Event` (`signal=`); setting it aborts a pending
  operation, reported as `unknown` + `lookup_failed`, as in TS.
  A resolver that accepts a second positional argument receives
  the caller's event, mirroring the TS signal parameter.

## Tests

The suite is not wired into the repo's npm test chain (which stays
npm-only). Run it with a virtualenv from the repo root:

```sh
python3 -m venv .venv
.venv/bin/pip install -e "packages/verify-py[test]"
.venv/bin/python -m pytest packages/verify-py
```

Live-chain tests are gated behind `LIVE_AGENTBOOK=1` (with
`LIVE_REGISTERED_ADDRESS` / `LIVE_UNREGISTERED_ADDRESS` set) and are
skipped by default, as in the TS package.

## Licence

Apache-2.0. Copyright 2026 Nic Lydon.
