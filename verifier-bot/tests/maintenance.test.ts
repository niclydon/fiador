import { afterEach, describe, expect, it, vi } from 'vitest';
import { pruneExpiredChecks, scheduleGuildSync, startCheckLogPruning } from '../src/maintenance.js';
import { InMemoryStore, SqliteStore, type CheckLogEntry, type Store } from '../src/store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const NOW_MS = Date.parse('2026-10-26T12:00:00.000Z');

function checkAt(checkedAt: number): CheckLogEntry {
  return {
    guildId: 'guild-1',
    applicationId: 'application-1',
    checkedAt: new Date(checkedAt).toISOString(),
    status: 'verified',
    failures: [],
    wallet: '0x1234567890123456789012345678901234567890',
    humanHash: 'a'.repeat(64),
    expiresAt: null,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('check log retention', () => {
  for (const [name, create] of [
    ['SQLite', () => new SqliteStore(':memory:')],
    ['in-memory', () => new InMemoryStore()],
  ] as const) {
    it(`removes only entries older than 90 days from ${name}`, () => {
      const store: Store = create();
      const cutoffMs = NOW_MS - 90 * DAY_MS;
      store.appendCheckLog(checkAt(cutoffMs - 1));
      store.appendCheckLog(checkAt(cutoffMs));
      store.appendCheckLog(checkAt(cutoffMs + 1));

      expect(pruneExpiredChecks(store, NOW_MS)).toBe(1);
      const remaining = store.listCheckLog('guild-1');
      expect(remaining.map((entry) => entry.checkedAt)).toEqual([
        new Date(cutoffMs + 1).toISOString(),
        new Date(cutoffMs).toISOString(),
      ]);
      expect(remaining.every((entry) => entry.wallet !== null && entry.humanHash !== null)).toBe(true);
      store.close();
    });
  }

  it('prunes at startup and again while a long-lived bot is running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const store = new InMemoryStore();
    store.appendCheckLog(checkAt(NOW_MS - 90 * DAY_MS - 1));
    const timer = startCheckLogPruning(store);
    expect(store.listCheckLog('guild-1')).toHaveLength(0);

    store.appendCheckLog(checkAt(NOW_MS - 89 * DAY_MS));
    await vi.advanceTimersByTimeAsync(2 * DAY_MS);
    expect(store.listCheckLog('guild-1')).toHaveLength(0);
    clearInterval(timer);
  });
});

describe('per-guild sync schedule', () => {
  it('respects separate intervals and a later guild setup change', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter in the test
    const store = new InMemoryStore();
    const config = (guildId: string, syncIntervalMinutes: number) => ({
      guildId,
      roleId: null,
      registryUrl: null,
      syncIntervalMinutes,
      logChannelId: null,
    });
    store.upsertGuildConfig(config('hourly', 60));
    store.upsertGuildConfig(config('two-hourly', 120));
    const syncer = { syncGuild: vi.fn(async (_guildId: string) => []) };
    const scheduler = scheduleGuildSync(store, syncer, 360);

    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(syncer.syncGuild.mock.calls.map(([id]) => id)).toEqual(['hourly']);
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(syncer.syncGuild.mock.calls.map(([id]) => id)).toEqual([
      'hourly', 'hourly', 'two-hourly',
    ]);

    store.upsertGuildConfig(config('hourly', 240));
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(syncer.syncGuild.mock.calls.map(([id]) => id)).toEqual([
      'hourly', 'hourly', 'two-hourly',
    ]);

    store.upsertGuildConfig(config('new-guild', 360));
    await vi.advanceTimersByTimeAsync(30 * 1000);
    expect(syncer.syncGuild.mock.calls.at(-1)?.[0]).toBe('new-guild');
    scheduler.stop();
  });
});
