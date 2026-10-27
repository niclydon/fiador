import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalAttestationMessage, createVerifier } from '@fiador/verify';
import { keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SqliteNonceStore } from '../dist/index.js';

const WALLET = `0x${'Ab'.repeat(20)}`;
const OTHER_WALLET = `0x${'Cd'.repeat(20)}`;
const NONCE = 'ab'.repeat(32);
const HOUR_MS = 60 * 60 * 1000;

async function temporaryDatabase(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fiador-nonce-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'nonces.db');
}

function awaitMessage(child, stage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error(`worker did not send ${stage}`)), 10_000);
    const onMessage = (message) => {
      if (message?.stage === 'error') {
        fail(new Error(message.message));
      } else if (message?.stage === stage) {
        cleanup();
        resolve(message);
      }
    };
    const onExit = (code) => fail(new Error(
      `worker exited ${code} before ${stage}: ${child.stderrText?.() ?? ''}`,
    ));
    const onError = (error) => fail(error);
    function cleanup() {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    }
    function fail(error) {
      cleanup();
      reject(error);
    }
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

test('claim is durable, case-insensitive by wallet, and scoped to that wallet', async (t) => {
  const path = await temporaryDatabase(t);
  const store = new SqliteNonceStore(path);
  const future = new Date(Date.now() + HOUR_MS).toISOString();
  const past = new Date(Date.now() - HOUR_MS).toISOString();
  assert.equal(await store.has(NONCE, WALLET), false);
  assert.equal(await store.claim(NONCE, WALLET, future), 'claimed');
  assert.equal(await store.has(NONCE, WALLET.toLowerCase()), true);
  assert.equal(await store.claim(NONCE, WALLET.toLowerCase(), past), 'replay');
  assert.equal(await store.has(NONCE, OTHER_WALLET), false);
  assert.equal(await store.claim(NONCE, OTHER_WALLET, future), 'claimed');
  store.close();

  const reopened = new SqliteNonceStore(path);
  assert.equal(await reopened.has(NONCE, WALLET), true);
  assert.equal(await reopened.has(NONCE, OTHER_WALLET), true);
  reopened.close();
});

test('the SQLite clock, not Date.now in the caller, decides expiry', async (t) => {
  const path = await temporaryDatabase(t);
  const store = new SqliteNonceStore(path);
  const realNow = Date.now();
  const originalDateNow = Date.now;
  try {
    Date.now = () => realNow + 365 * 24 * HOUR_MS;
    assert.equal(
      await store.claim('cd'.repeat(32), WALLET, new Date(realNow + HOUR_MS).toISOString()),
      'claimed',
    );
    Date.now = () => realNow - 365 * 24 * HOUR_MS;
    assert.equal(
      await store.claim('ef'.repeat(32), WALLET, new Date(realNow - HOUR_MS).toISOString()),
      'expired',
    );
    assert.equal(await store.has('ef'.repeat(32), WALLET), false);
  } finally {
    Date.now = originalDateNow;
    store.close();
  }
});

test('two processes that both read has=false have exactly one claim winner', async (t) => {
  const path = await temporaryDatabase(t);
  const future = new Date(Date.now() + HOUR_MS).toISOString();
  const workerFile = fileURLToPath(new URL('./claim-worker.mjs', import.meta.url));
  const args = [path, NONCE, WALLET, future];
  const children = Array.from({ length: 2 }, () => {
    const child = fork(workerFile, args, {
      execArgv: ['--no-warnings'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stderrText = () => stderr;
    return child;
  });
  t.after(() => children.forEach((child) => child.kill()));
  const ready = await Promise.all(children.map((child) => awaitMessage(child, 'ready')));
  assert.deepEqual(ready.map((message) => message.hadClaim), [false, false]);
  const outcomes = children.map((child) => awaitMessage(child, 'done'));
  children.forEach((child) => child.send('claim'));
  assert.deepEqual(
    (await Promise.all(outcomes)).map((message) => message.outcome).sort(),
    ['claimed', 'replay'],
  );
  const reopened = new SqliteNonceStore(path);
  assert.equal(await reopened.has(NONCE, WALLET), true);
  reopened.close();
});

test('an insert error rolls the transaction back and leaves the nonce fresh', async (t) => {
  const path = await temporaryDatabase(t);
  const store = new SqliteNonceStore(path);
  const db = new DatabaseSync(path);
  db.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON nonce_claims
    BEGIN SELECT RAISE(ABORT, 'forced insert failure'); END`);
  const future = new Date(Date.now() + HOUR_MS).toISOString();
  await assert.rejects(store.claim(NONCE, WALLET, future), /forced insert failure/);
  assert.equal(await store.has(NONCE, WALLET), false);
  db.exec('DROP TRIGGER fail_insert');
  assert.equal(await store.claim(NONCE, WALLET, future), 'claimed');
  db.close();
  store.close();
});

test('a committed claim with a lost response is unknown and remains durable', async (t) => {
  const path = await temporaryDatabase(t);
  const store = new SqliteNonceStore(path);
  const account = privateKeyToAccount(keccak256(toBytes('fiador-sqlite-nonce-synthetic-test-key')));
  const current = Date.now();
  const payload = {
    version: 1,
    subject: { type: 'discord_application', id: '111111111111111111' },
    agentWalletAddress: account.address,
    humanIdDisclosure: 'none',
    issuedAt: new Date(current - 60_000).toISOString(),
    expiresAt: new Date(current + HOUR_MS).toISOString(),
    nonce: '12'.repeat(32),
  };
  const attestation = {
    payload,
    signature: await account.signMessage({ message: canonicalAttestationMessage(payload) }),
    signatureType: 'eip191',
  };
  const verifier = createVerifier({
    reader: {
      source: 'fixture',
      async lookupHuman() { return `0x${'a1'.repeat(32)}`; },
    },
  });
  const lostResponseStore = {
    has: (nonce, wallet) => store.has(nonce, wallet),
    async claim(nonce, wallet, expiresAt) {
      assert.equal(await store.claim(nonce, wallet, expiresAt), 'claimed');
      throw new Error('claim committed but its response was lost');
    },
  };
  const result = await verifier.verifyAttestation(attestation, { nonceStore: lostResponseStore });
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.failures, ['lookup_failed']);
  store.close();

  const reopened = new SqliteNonceStore(path);
  assert.equal(await reopened.has(payload.nonce, account.address), true);
  const second = await verifier.verifyAttestation(attestation, { nonceStore: reopened });
  assert.equal(second.status, 'invalid');
  assert.deepEqual(second.failures, ['replay_detected']);
  reopened.close();
});

test('pruning is explicit and only removes expired rows', async (t) => {
  const path = await temporaryDatabase(t);
  const store = new SqliteNonceStore(path);
  const db = new DatabaseSync(path);
  db.prepare(`INSERT INTO nonce_claims (wallet, nonce, expires_at_ms, claimed_at_ms)
    VALUES (?, ?, ?, ?)`).run(WALLET.toLowerCase(), NONCE, Date.now() - HOUR_MS, Date.now() - 2 * HOUR_MS);
  const activeNonce = '98'.repeat(32);
  assert.equal(await store.claim(activeNonce, WALLET, new Date(Date.now() + HOUR_MS).toISOString()), 'claimed');
  assert.equal(store.pruneExpired(), 1);
  assert.equal(await store.has(activeNonce, WALLET), true);
  assert.equal(await store.has(NONCE, WALLET), false);
  db.close();
  store.close();
});

test('a 022 umask still produces owner-only DB, WAL, and SHM files', async (t) => {
  const path = await temporaryDatabase(t);
  const previousUmask = process.umask(0o022);
  try {
    const store = new SqliteNonceStore(path);
    await store.claim(NONCE, WALLET, new Date(Date.now() + HOUR_MS).toISOString());
    for (const suffix of ['', '-wal', '-shm']) {
      const file = await stat(`${path}${suffix}`);
      assert.equal(file.mode & 0o777, 0o600, `${suffix || 'database'} must be private`);
      assert.equal(file.uid, process.getuid());
    }
    store.close();
  } finally {
    process.umask(previousUmask);
  }
});

test('unsafe parent, database, sidecar, and symlink paths fail closed', async (t) => {
  const path = await temporaryDatabase(t);
  const directory = join(path, '..');
  const publicDirectory = join(directory, 'public');
  await mkdir(publicDirectory);
  await chmod(publicDirectory, 0o755);
  assert.throws(
    () => new SqliteNonceStore(join(publicDirectory, 'nonces.db')),
    /owner-only directory/,
  );
  const parentLink = join(directory, 'linked-parent');
  await symlink(directory, parentLink);
  assert.throws(
    () => new SqliteNonceStore(join(parentLink, 'nonces.db')),
    /owner-only directory/,
  );

  const store = new SqliteNonceStore(path);
  await store.claim(NONCE, WALLET, new Date(Date.now() + HOUR_MS).toISOString());
  await chmod(`${path}-wal`, 0o644);
  assert.throws(() => new SqliteNonceStore(path), /owner-only file/);
  await chmod(`${path}-wal`, 0o600);
  store.close();

  await chmod(path, 0o644);
  assert.throws(() => new SqliteNonceStore(path), /owner-only file/);
  await chmod(path, 0o600);
  const fileLink = join(directory, 'linked.db');
  await symlink(path, fileLink);
  assert.throws(() => new SqliteNonceStore(fileLink), /owner-only file/);
});

test('copying only the main WAL-mode DB omits a committed claim', async (t) => {
  const path = await temporaryDatabase(t);
  // Closing the setup connection checkpoints the schema into the main DB.
  new SqliteNonceStore(path).close();
  const live = new SqliteNonceStore(path);
  assert.equal(await live.claim(NONCE, WALLET, new Date(Date.now() + HOUR_MS).toISOString()), 'claimed');
  assert.ok((await stat(`${path}-wal`)).size > 0);
  const backupDirectory = await mkdtemp(join(tmpdir(), 'fiador-stale-copy-'));
  t.after(() => rm(backupDirectory, { recursive: true, force: true }));
  const copiedPath = join(backupDirectory, 'nonces.db');
  await copyFile(path, copiedPath);
  const copied = new SqliteNonceStore(copiedPath);
  assert.equal(await copied.has(NONCE, WALLET), false);
  assert.equal(await live.has(NONCE, WALLET), true);
  copied.close();
  live.close();
});

test('a SQLite online snapshot includes a committed WAL claim', async (t) => {
  const path = await temporaryDatabase(t);
  const live = new SqliteNonceStore(path);
  assert.equal(await live.claim(NONCE, WALLET, new Date(Date.now() + HOUR_MS).toISOString()), 'claimed');
  const backupDirectory = await mkdtemp(join(tmpdir(), 'fiador-online-backup-'));
  t.after(() => rm(backupDirectory, { recursive: true, force: true }));
  const snapshotPath = join(backupDirectory, 'snapshot.db');
  const backupConnection = new DatabaseSync(path);
  backupConnection.prepare('VACUUM INTO ?').run(snapshotPath);
  backupConnection.close();
  await chmod(snapshotPath, 0o600);
  const snapshot = new SqliteNonceStore(snapshotPath);
  assert.equal(await snapshot.has(NONCE, WALLET), true);
  snapshot.close();
  live.close();
});
