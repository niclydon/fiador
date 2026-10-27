# @fiador/verify-nonce-sqlite

An optional local SQLite nonce store for a **one-use** Fiador attestation
check. It implements the `has` and `claim` interface accepted by
`@fiador/verify`'s `verifyAttestation` option. Requires Node 22.13 or newer;
the browser-safe verifier core has no SQLite dependency.

```ts
import { createVerifier } from '@fiador/verify';
import { SqliteNonceStore } from '@fiador/verify-nonce-sqlite';

const store = new SqliteNonceStore('/var/lib/my-app/fiador-nonces.db');
try {
  const result = await createVerifier().verifyAttestation(attestation, {
    nonceStore: store,
  });
  // Consume the result according to your application's policy.
} finally {
  store.close();
}
```

Use one local SQLite file shared by all processes that check the same
one-use flow. The path must be absolute so different working directories
cannot silently create separate stores. `has` is a read-only replay check. `claim` takes an immediate
write transaction, checks an existing active claim first, compares expiry
with SQLite's clock, and commits before returning `claimed`. Exactly one
process can claim a fresh `(wallet, nonce)` pair. The wallet key is
case-insensitive; other wallets have separate nonce spaces. An expired
claim can be replaced; `pruneExpired()` removes expired rows only when
called explicitly. Neither method releases an active claim.

If a claim commits but its response is lost, the verifier returns
`unknown`; the row remains claimed. Do not automatically retry or grant
access on `unknown`. A database lock or write failure is likewise an
unknown verification outcome. Keep the database and its WAL files on one
local filesystem. This package does not coordinate separate hosts, a
network filesystem, or independently copied database files.

Published Fiador attestations are meant to be checked repeatedly while
valid. Do **not** give this store to the public verify page, periodic bot
rechecks, or a badge check. Leave `nonceStore` unset for those repeatable
checks. Use this adapter only when the product explicitly requires a
one-use nonce.

The store contains wallet addresses, nonces, and timestamps. Protect and
back up its local files according to your application's data policy.
