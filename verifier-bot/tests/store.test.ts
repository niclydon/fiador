import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../src/store.js';

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
});
