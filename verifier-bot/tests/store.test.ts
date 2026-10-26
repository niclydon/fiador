import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { InMemoryStore, SqliteStore } from '../src/store.js';

describe('SqliteStore (node:sqlite, in-memory database)', () => {
  it('round-trips guild config, bindings, and check log', () => {
    const store = new SqliteStore(':memory:');
    store.upsertGuildConfig({
      guildId: 'g1',
      roleId: 'r1',
      registryUrl: 'https://registry.example.com/registry.json',
      syncIntervalMinutes: 360,
      logChannelId: null,
    });
    expect(store.getGuildConfig('g1')).toMatchObject({ roleId: 'r1', syncIntervalMinutes: 360 });

    store.upsertBinding({
      guildId: 'g1',
      applicationId: 'a1',
      attestationUrl: 'https://operator.example.com/attestation.json',
      payloadHash: 'abc',
      boundVia: 'url',
      boundBy: 'u1',
      boundAt: '2026-10-25T00:00:00.000Z',
      botUserId: 'b1',
    });
    expect(store.listBindings('g1')).toHaveLength(1);
    expect(store.getBinding('g1', 'a1')?.botUserId).toBe('b1');

    store.appendCheckLog({
      guildId: 'g1',
      applicationId: 'a1',
      checkedAt: '2026-10-26T04:00:00.000Z',
      status: 'unknown',
      failures: ['lookup_failed'],
      wallet: null,
      humanHash: null,
      expiresAt: null,
    });
    const latest = store.getLatestCheck('g1', 'a1');
    // The whole point of the verbatim status column: unknown stays unknown.
    expect(latest?.status).toBe('unknown');
    expect(latest?.failures).toEqual(['lookup_failed']);
    store.close();
  });

  it('includes a guild with legacy claims even if it has no config row', () => {
    const store = new SqliteStore(':memory:');
    store.upsertBinding({
      guildId: 'legacy-only',
      applicationId: 'a1',
      attestationUrl: 'https://operator.example.com/attestation.json',
      payloadHash: null,
      boundVia: 'url',
      boundBy: 'u1',
      boundAt: '2026-10-25T00:00:00.000Z',
      botUserId: null,
    });
    expect(store.listGuildIds()).toContain('legacy-only');
    store.close();
  });

  it('keeps the in-memory store guild enumeration aligned with SQLite', () => {
    const store = new InMemoryStore();
    store.upsertBinding({
      guildId: 'legacy-only',
      applicationId: 'a1',
      attestationUrl: 'https://operator.example.com/attestation.json',
      payloadHash: null,
      boundVia: 'url',
      boundBy: 'u1',
      boundAt: '2026-10-25T00:00:00.000Z',
      botUserId: null,
    });
    expect(store.listGuildIds()).toContain('legacy-only');
  });
});

describe('durable one-use witness rows', () => {
  it('survives restart and allows exactly one concurrent consumer across SQLite connections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fiador-witness-'));
    const path = join(dir, 'state.db');
    try {
      const initial = new SqliteStore(path);
      initial.saveControlChallenge({
        nonce: 'aa'.repeat(32), guildId: '111111111111111111', channelId: '222222222222222222',
        verifierBotUserId: '333333333333333333', applicationId: '444444444444444444',
        botUserId: '555555555555555555', wallet: '0x1234567890AbcdEF1234567890aBcdef12345678',
        payloadHash: 'bb'.repeat(32), attestationUrl: 'https://example.com/a.json',
        issuedAt: '2026-10-26T20:00:00.000Z', expiresAt: '2026-10-26T20:10:00.000Z',
        consumedAt: null, messageId: null,
      });
      initial.close();
      const a = new SqliteStore(path);
      const b = new SqliteStore(path);
      expect(a.getControlChallenge('aa'.repeat(32))?.botUserId).toBe('555555555555555555');
      expect(a.consumeControlChallenge('aa'.repeat(32), '2026-10-26T20:02:00.000Z', '666666666666666666')).toBe(true);
      expect(b.consumeControlChallenge('aa'.repeat(32), '2026-10-26T20:03:00.000Z', '777777777777777777')).toBe(false);
      expect(b.getControlChallenge('aa'.repeat(32))?.messageId).toBe('666666666666666666');
      expect(b.pruneControlChallenges('2026-10-27T20:00:00.000Z')).toBe(1);
      expect(a.getControlChallenge('aa'.repeat(32))).toBeNull();
      a.close(); b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds witness storage to a pre-existing legacy claim database without changing the claim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fiador-legacy-'));
    const path = join(dir, 'state.db');
    try {
      const db = new DatabaseSync(path);
      db.exec(`CREATE TABLE binding (guild_id TEXT NOT NULL, application_id TEXT NOT NULL,
        attestation_url TEXT NOT NULL, payload_hash TEXT, bound_via TEXT NOT NULL,
        bound_by TEXT NOT NULL, bound_at TEXT NOT NULL, bot_user_id TEXT,
        PRIMARY KEY (guild_id, application_id));`);
      db.prepare(`INSERT INTO binding VALUES (?, ?, ?, NULL, 'url', 'legacy', ?, NULL)`)
        .run('g1', 'a1', 'https://example.com/old.json', '2026-10-25T00:00:00.000Z');
      db.close();
      const store = new SqliteStore(path);
      expect(store.getBinding('g1', 'a1')).toMatchObject({ boundVia: 'url', payloadHash: null });
      expect(store.getControlChallenge('aa'.repeat(32))).toBeNull();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
