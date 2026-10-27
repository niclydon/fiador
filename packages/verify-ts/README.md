# @fiador/verify

Verify that a unique human stands behind an agent wallet.

This package checks two things, live, against the AgentBook registry
on World Chain:

- `verifyAddress(address)` — is this wallet registered to a unique
  human right now?
- `verifyAttestation(attestation)` — is this signed operator claim
  authentic, in date, bound to the subject it claims, and backed by a
  registered wallet?
- `resolveStatus(subject)` — one call that composes the two for
  consumers (an address, an attestation, or a subject resolved to an
  attestation).

```ts
import { createVerifier, toPublicVerifyResult } from '@fiador/verify';

const verifier = createVerifier(); // defaults: World Chain, canonical AgentBook
const result = await verifier.verifyAddress('0x…');
console.log(toPublicVerifyResult(result)); // the only shape public outputs may take
```

## What a result means

A `verified` result means: at `evidence.checkedAt`, a live read of the
AgentBook contract showed this wallet registered to a unique human,
and (for attestations) the operator's signature, binding, and dates
all checked out. Five statuses exist — `verified`, `unregistered`,
`expired`, `invalid`, `unknown` — and they are kept distinct on
purpose: a lookup that failed returns `unknown`, never `unregistered`,
and no error path returns `verified`.

A check does **not** prove that a human wrote or approved any
particular message, that the software running is the software claimed,
or anything about a subject beyond the wallet registration and the
signed claim. The full threat model lives in the repository's
`docs/threat-model.md`.

## The hash-only rule

Public outputs never carry the full human identifier. Results cross
to any public surface only through `toPublicVerifyResult`, which
returns a fresh object with the truncated address and `humanHash` —
`sha256('w0-human-v1:' + humanId)`, the program's one canonical hash,
which lets two subjects be recognised as sharing one human without
revealing who it is. An attestation can narrow this further with
`humanIdDisclosure: 'none'`. There is no setting that publishes the
raw value. The verifier renders the 32-byte on-chain human ID as
lowercase hex before hashing, so equivalent uppercase and lowercase
reader answers yield one hash.

## Nonce stores (replay protection)

`verifyAttestation` accepts a `nonceStore` to enforce one-time
presentation of an attestation. The contract is a read-only
`has(nonce, wallet)` replay check plus an atomic
`claim(nonce, wallet, expiresAt)` taken only after registration
succeeds. The claim must be ATOMIC — exactly one of any number of
concurrent claims for a key may observe `'claimed'`. In a real
backend that means a single conditional write (an
`INSERT ... ON CONFLICT DO NOTHING`, a `SET NX`, a conditional
update whose affected-row count is the answer); a check-then-set
across two round-trips is a race, not a claim. The package ships
`InMemoryNonceStore`, whose claim is atomic by construction (its
check-and-set runs in one synchronous pass), and the test suite
exercises it — alongside an async store double modelling a
conforming backend — under concurrent double-presentation. Treat
that conformance test as the executable definition of the
contract when writing a production store.

Because the claim is taken only at the terminal step, earlier
lookup failures, unregistered wallets, and expired documents never
burn a nonce. Once a claim starts, an unknown result may mean its
answer was lost after the store recorded it. Do not release that
claim or automatically retry it. Entries lapse at the attestation's
own `expiresAt`, and the store checks its own clock at the write
point, returning `'expired'` rather than recording a stale claim.
Store read and claim errors, including deadlines, return `unknown` +
`lookup_failed` unless an established invalid or expired result takes
precedence.

## Nonce stores (replay protection)

`verifyAttestation` accepts a `nonceStore` to enforce one-time
presentation of an attestation. The contract is a read-only
`has(nonce, wallet)` replay check plus an atomic
`claim(nonce, wallet, expiresAt)` taken only after registration
succeeds. The claim must be ATOMIC — exactly one of any number of
concurrent claims for a key may observe `'claimed'`. In a real
backend that means a single conditional write (an
`INSERT ... ON CONFLICT DO NOTHING`, a `SET NX`, a conditional
update whose affected-row count is the answer); a check-then-set
across two round-trips is a race, not a claim. The package ships
`InMemoryNonceStore`, whose claim is atomic by construction (its
check-and-set runs in one synchronous pass), and the test suite
exercises it — alongside an async store double modelling a
conforming backend — under concurrent double-presentation. Treat
that conformance test as the executable definition of the
contract when writing a production store.

Because the claim is taken only at the terminal step, outcomes
resolved before the final claim (a lookup failure, an
unregistered wallet, an expired document) never burn a nonce:
the presentation can simply be retried. The one exception is
the claim itself: a lost or timed-out claim response is
`unknown` + `lookup_failed` with the nonce possibly consumed
(SPEC 3.3) — the write may have committed, and the contract is
exactly `{ has, claim }`, with no `release()` and no automatic
retry. Entries lapse at the attestation's own `expiresAt`, and
the store checks its own clock at the write point, returning
`'expired'` rather than recording a stale claim.

## Design notes

- No private keys, ever. Verification is public-input only:
  addresses, signatures, contract reads.
- AgentBook reads go through an injectable `AgentBookReader`;
  ERC-1271 checks use the configured World Chain RPC. Tests run
  offline against fixtures (`fixtures/vectors.json`,
  generated deterministically by `scripts/gen-fixtures.ts`; every
  fixture is synthetic). The fixture keys are public-by-construction:
  each is the keccak256 of a seed string committed in the generator,
  so anyone can re-derive them. The fixture addresses are therefore
  burned — never fund them, never register them, never demo with
  them.
- Trust model, stated plainly: the configured RPC endpoint is the
  trust oracle for registration answers — whatever it returns is
  the lookup result. The reader's chain-id check is a
  misconfiguration guard (it catches an endpoint answering for a
  different chain); it does not authenticate the endpoint. For that
  reason non-https RPC URLs are rejected at construction, loopback
  excepted.
- The default reader reads the contract directly with viem rather
  than wrapping the AgentKit SDK's verifier: the SDK (0.2.1)
  collapses RPC failures into a null result, and this package's
  `unregistered` vs `unknown` distinction depends on never doing
  that.
- Clocks are injectable (`now`, `clockSkewMs`), so expiry behaviour
  is deterministically testable.
- One-use flows can pass the optional Node-only
  `@fiador/verify-nonce-sqlite` store as `nonceStore`. Published
  attestations and the bot's periodic checks are repeatable and do
  not use it.

Apache-2.0. Created by Nic Lydon.
