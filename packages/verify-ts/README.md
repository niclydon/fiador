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
- `verifySignedMessage({ message, signature, signatureType,
  expectedAddress })` — is this arbitrary signed message authentic
  for its signer? Signature-only (EOA recovery or ERC-1271, the
  path caller-declared): no registration check, so compose with
  `verifyAddress` when registration matters.

For ERC-1271, a non-magic result, contract revert, or empty return is
`signature_mismatch`. An unavailable or wrong-chain RPC is
`lookup_failed`; a timed-out check is `lookup_timeout`. Both RPC
failure results leave `verified` false without claiming the signature
was rejected. A malformed message or signature is rejected before
any RPC; contract signatures may be any even-length `0x` hex bytes.

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
raw value.

## Design notes

- No private keys, ever. Verification is public-input only:
  addresses, signatures, contract reads.
- AgentBook reads go through an injectable `AgentBookReader`;
  ERC-1271 checks use the configured World Chain RPC. Tests run
  offline against synthetic fixtures (`fixtures/vectors.json`,
  generated deterministically by `scripts/gen-fixtures.ts`).
- The default reader reads the contract directly with viem rather
  than wrapping the AgentKit SDK's verifier: the SDK (0.2.1)
  collapses RPC failures into a null result, and this package's
  `unregistered` vs `unknown` distinction depends on never doing
  that.
- Clocks are injectable (`now`, `clockSkewMs`), so expiry behaviour
  is deterministically testable.

Apache-2.0. Created by Nic Lydon.
