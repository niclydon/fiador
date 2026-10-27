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
cannot silently create separate stores. The parent directory must already
be owned by the service user with mode `0700`; the database must be a regular
owner-owned file with mode `0600`. Existing group-readable files and symlinks
are rejected, including symlinks in the parent path. Use the parent's real,
canonical path and keep its ancestors under trusted ownership. A new database
is created with mode `0600` even under umask
`022`; SQLite's WAL and SHM files inherit that mode. This adapter requires a
POSIX host so it can check ownership and permissions.

`has` is a read-only replay check. `claim` takes an immediate write
transaction, checks an existing active claim first, compares expiry with
SQLite's clock, and commits before returning `claimed`. It requires WAL
journaling and FULL synchronization. Exactly one process can claim a fresh
`(wallet, nonce)` pair. The wallet key is case-insensitive; other wallets
have separate nonce spaces. An expired claim can be replaced; schedule
`pruneExpired()` (for example, daily) to remove expired rows. Pruning is
explicit and never releases an active claim.

If a claim commits but its response is lost, the verifier returns
`unknown`; the row remains claimed. Do not automatically retry or grant
access on `unknown`. A database lock or write failure is likewise an
unknown verification outcome. Keep the database and its WAL files on one
local filesystem. This package does not coordinate separate hosts, a
network filesystem, or independently copied database files.

## Backup and recovery

Back up a live store with SQLite's online backup mechanism or `VACUUM INTO`,
writing the snapshot inside an owner-only directory and setting its file
mode to `0600` before moving it. Record the snapshot time. Do not copy only
the `.db` file while WAL mode is active: a committed claim may still exist
only in `.db-wal`. Copying `.db`, `.db-wal`, and `.db-shm` one by one while
checks continue is not a consistent snapshot either. The package tests
demonstrate both a stale `.db`-only copy and a consistent `VACUUM INTO`
snapshot.

**Hold one-use checks before restoring any snapshot.** Even a consistent
snapshot loses claims committed after its creation. The host service must
keep this recovery gate closed until either:

1. Every claim committed after the snapshot has been reconciled from a
   separate, complete, durable claim journal, and each still-active claim
   is present in the restored store; or
2. Every attestation that could have been checked before the restore has
   expired. If that set is unknown, keep one-use checks disabled for the
   protocol's 90-day maximum lifetime plus the configured clock skew after
   the restore cutoff.

This package cannot detect that its database was rolled back. The service
operator must enforce the gate outside this database. A new empty database
is not a safe replacement for a lost one while old attestations remain
valid. Retain snapshots in private storage under the application's data
retention policy.

Published Fiador attestations are meant to be checked repeatedly while
valid. Do **not** give this store to the public verify page, periodic bot
rechecks, or a badge check. Leave `nonceStore` unset for those repeatable
checks. Use this adapter only when the product explicitly requires a
one-use nonce.

The store contains wallet addresses, nonces, and timestamps; treat its
directory and backups as private records.
