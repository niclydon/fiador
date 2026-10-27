import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { EvmAddress, NonceClaimResult, VerifyAttestationOptions } from '@fiador/verify';

type NonceStore = NonNullable<VerifyAttestationOptions['nonceStore']>;

// SQLite's clock is shared by every process using this file. A caller's
// Date.now() must not decide whether an active claim may be replaced.
const SQLITE_NOW_MS =
  "CAST(strftime('%s', 'now') AS INTEGER) * 1000 + " +
  "CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nonce_claims (
  wallet TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  claimed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (wallet, nonce)
) WITHOUT ROWID;
`;
const SETUP_WAIT = new Int32Array(new SharedArrayBuffer(4));

function enableWal(db: DatabaseSync): void {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const current = db.prepare('PRAGMA journal_mode').get() as
        | { journal_mode: string }
        | undefined;
      if (current?.journal_mode?.toLowerCase() === 'wal') return;
      const changed = db.prepare('PRAGMA journal_mode = WAL').get() as
        | { journal_mode: string }
        | undefined;
      if (changed?.journal_mode?.toLowerCase() !== 'wal') {
        throw new Error('SQLite WAL mode is required');
      }
      return;
    } catch (error) {
      // Switching a brand-new file into WAL can return SQLITE_BUSY before
      // busy_timeout applies when another process is doing the same setup.
      // This only waits for idempotent initialization, never retries a claim.
      if ((error as { errcode?: unknown }).errcode !== 5 || Date.now() >= deadline) {
        throw error;
      }
      Atomics.wait(SETUP_WAIT, 0, 0, 25);
    }
  }
}

function ownerUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('private SQLite file checks require a POSIX host');
  }
  return uid;
}

function privateFileIfPresent(path: string, uid: number): boolean {
  let file: ReturnType<typeof lstatSync>;
  try {
    file = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (
    !file.isFile() || file.isSymbolicLink() || file.uid !== uid ||
    (file.mode & 0o600) !== 0o600 || (file.mode & 0o077) !== 0
  ) {
    throw new Error(`SQLite file must be a regular owner-only file: ${path}`);
  }
  return true;
}

function checkPrivateFiles(dbPath: string, uid: number): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    privateFileIfPresent(`${dbPath}${suffix}`, uid);
  }
}

function preparePrivateFile(dbPath: string): number {
  const uid = ownerUid();
  const parentPath = dirname(dbPath);
  if (realpathSync(parentPath) !== resolve(parentPath)) {
    throw new Error(`SQLite parent path must not contain symlinks: ${parentPath}`);
  }
  const parent = lstatSync(parentPath);
  if (
    !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid ||
    (parent.mode & 0o700) !== 0o700 || (parent.mode & 0o077) !== 0
  ) {
    throw new Error(`SQLite parent must be an owner-only directory: ${parentPath}`);
  }
  checkPrivateFiles(dbPath, uid);
  if (!privateFileIfPresent(dbPath, uid)) {
    try {
      // SQLite otherwise creates 0644 files under a common umask of 022.
      // Its WAL and SHM files inherit this pre-created file's 0600 mode.
      const fd = openSync(
        dbPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      closeSync(fd);
    } catch (error) {
      // Another trusted process may have won the first-open race. It must
      // have created the same private regular file before we use it.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!privateFileIfPresent(dbPath, uid)) {
      throw new Error('SQLite file was not created');
    }
  }
  return uid;
}

function key(nonce: string, wallet: EvmAddress): [string, string] {
  if (typeof wallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    throw new TypeError('wallet must be an EVM address');
  }
  if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 128) {
    throw new TypeError('nonce must be a nonempty string of at most 128 characters');
  }
  return [wallet.toLowerCase(), nonce];
}

function expiryMs(expiresAt: string): number {
  if (typeof expiresAt !== 'string' || !expiresAt.endsWith('Z')) {
    throw new TypeError('expiresAt must be a UTC timestamp');
  }
  const ms = Date.parse(expiresAt);
  if (!Number.isSafeInteger(ms)) {
    throw new TypeError('expiresAt must be a valid UTC timestamp');
  }
  return ms;
}

/**
 * Durable, local-file nonce store for one-use verification flows. A claim is
 * committed before `claimed` is returned; callers must treat a lost response
 * or a database error as unknown, never as permission to retry that nonce.
 */
export class SqliteNonceStore implements NonceStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (typeof dbPath !== 'string' || !isAbsolute(dbPath)) {
      throw new TypeError('dbPath must be an absolute path to a local SQLite file');
    }
    const uid = preparePrivateFile(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA busy_timeout = 10000');
      enableWal(db);
      db.exec('PRAGMA synchronous = FULL');
      const sync = db.prepare('PRAGMA synchronous').get() as
        | { synchronous: number }
        | undefined;
      if (sync?.synchronous !== 2) {
        throw new Error('SQLite FULL synchronous mode is required');
      }
      db.exec(SCHEMA);
      // Reject old unsafe sidecars as well as any newly created under a
      // SQLite build that does not inherit the database's 0600 mode.
      checkPrivateFiles(dbPath, uid);
    } catch (error) {
      try { db.close(); } catch { /* preserve the setup error */ }
      throw error;
    }
    this.db = db;
  }

  async has(nonce: string, wallet: EvmAddress): Promise<boolean> {
    const [normalisedWallet, checkedNonce] = key(nonce, wallet);
    const row = this.db.prepare(`
      SELECT 1 AS active FROM nonce_claims
      WHERE wallet = ? AND nonce = ? AND expires_at_ms > ${SQLITE_NOW_MS}
    `).get(normalisedWallet, checkedNonce);
    return row !== undefined;
  }

  async claim(
    nonce: string,
    wallet: EvmAddress,
    expiresAt: string,
  ): Promise<NonceClaimResult> {
    const [normalisedWallet, checkedNonce] = key(nonce, wallet);
    const requestedExpiryMs = expiryMs(expiresAt);
    let transactionOpen = false;
    try {
      // BEGIN IMMEDIATE serialises claim decisions across processes sharing
      // this local file; a preceding has(false) is never the write guard.
      this.db.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      const clock = this.db.prepare(`SELECT ${SQLITE_NOW_MS} AS now_ms`).get() as
        | { now_ms: number }
        | undefined;
      if (!clock || !Number.isSafeInteger(clock.now_ms)) {
        throw new Error('SQLite clock was unavailable');
      }
      const nowMs = clock.now_ms;
      const existing = this.db.prepare(`
        SELECT expires_at_ms FROM nonce_claims WHERE wallet = ? AND nonce = ?
      `).get(normalisedWallet, checkedNonce) as
        | { expires_at_ms: number }
        | undefined;

      // An already-active claim wins even if the newly presented expiry is
      // past. This preserves replay precedence and never releases a claim.
      if (existing && existing.expires_at_ms > nowMs) {
        this.db.exec('ROLLBACK');
        transactionOpen = false;
        return 'replay';
      }
      if (requestedExpiryMs <= nowMs) {
        this.db.exec('ROLLBACK');
        transactionOpen = false;
        return 'expired';
      }

      // Re-evaluate the SQLite clock in the INSERT itself. An expiry that
      // passes between our earlier read and this write cannot be recorded.
      const write = this.db.prepare(`
        INSERT INTO nonce_claims (wallet, nonce, expires_at_ms, claimed_at_ms)
        SELECT ?, ?, ?, ${SQLITE_NOW_MS}
        WHERE ? > ${SQLITE_NOW_MS}
        ON CONFLICT(wallet, nonce) DO UPDATE SET
          expires_at_ms = excluded.expires_at_ms,
          claimed_at_ms = excluded.claimed_at_ms
        WHERE nonce_claims.expires_at_ms <= ${SQLITE_NOW_MS}
      `).run(normalisedWallet, checkedNonce, requestedExpiryMs, requestedExpiryMs);
      if (write.changes === 0) {
        // No row was written: either the supplied expiry passed during the
        // transaction, or a backwards clock step made an old row active.
        const active = this.db.prepare(`
          SELECT 1 FROM nonce_claims
          WHERE wallet = ? AND nonce = ? AND expires_at_ms > ${SQLITE_NOW_MS}
        `).get(normalisedWallet, checkedNonce);
        this.db.exec('ROLLBACK');
        transactionOpen = false;
        return active ? 'replay' : 'expired';
      }
      this.db.exec('COMMIT');
      transactionOpen = false;
      return 'claimed';
    } catch (error) {
      if (transactionOpen) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // Preserve the original failure. The caller still gets unknown;
          // a lost outcome must not be followed by an automatic retry.
        }
      }
      throw error;
    }
  }

  /** Explicit storage cleanup; it never removes an active claim. */
  pruneExpired(): number {
    const result = this.db.prepare(`
      DELETE FROM nonce_claims WHERE expires_at_ms <= ${SQLITE_NOW_MS}
    `).run();
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}
