import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';
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
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA busy_timeout = 10000');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      db.exec(SCHEMA);
    } catch (error) {
      db.close();
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
