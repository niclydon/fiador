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
  const config = (guildId: string, syncIntervalMinutes: number) => ({
    guildId,
    roleId: null,
    registryUrl: null,
    syncIntervalMinutes,
    logChannelId: null,
  });

  it('starts other guilds even while the first startup check is pending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const store = new InMemoryStore();
    store.upsertGuildConfig(config('a-slow', 60));
    store.upsertGuildConfig(config('b-fast', 60));
    let releaseSlow: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const audits: string[] = [];
    const syncer = { syncGuild: vi.fn(async (guildId: string) => {
      if (guildId === 'a-slow') await slow;
      return [];
    }) };
    const scheduler = scheduleGuildSync(store, syncer, 360, async (guildId) => {
      audits.push(guildId);
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(audits).toEqual(['a-slow', 'b-fast']);
    expect(syncer.syncGuild.mock.calls.map(([id]) => id)).toEqual(['a-slow', 'b-fast']);

    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(syncer.syncGuild.mock.calls.map(([id]) => id)).toEqual([
      'a-slow', 'b-fast', 'b-fast',
    ]);
    expect(audits).toEqual(['a-slow', 'b-fast']);
    releaseSlow?.();
    await vi.advanceTimersByTimeAsync(1);
    scheduler.stop();
  });

  it('still checks a guild when its startup audit warning fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new InMemoryStore();
    store.upsertGuildConfig(config('guild-1', 60));
    const syncer = { syncGuild: vi.fn(async (_guildId: string) => []) };
    const scheduler = scheduleGuildSync(store, syncer, 360, async () => {
      throw new Error('audit unavailable');
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(syncer.syncGuild).toHaveBeenCalledExactlyOnceWith('guild-1');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('startup audit failed'));
    scheduler.stop();
  });

  it('respects separate intervals and a later guild setup change', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter in the test
    const store = new InMemoryStore();
    store.upsertGuildConfig(config('hourly', 60));
    store.upsertGuildConfig(config('two-hourly', 120));
    const syncer = { syncGuild: vi.fn(async (_guildId: string) => []) };
    const scheduler = scheduleGuildSync(store, syncer, 360);

    await vi.advanceTimersByTimeAsync(1);
    expect(syncer.syncGuild.mock.calls.map(([id]) => id)).toEqual([
      'hourly', 'two-hourly',
    ]);
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(syncer.syncGuild.mock.calls.map(([id]) => id)).toEqual([
      'hourly', 'two-hourly', 'hourly',
    ]);
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(syncer.syncGuild.mock.calls.map(([id]) => id)).toEqual([
      'hourly', 'two-hourly', 'hourly', 'hourly', 'two-hourly',
    ]);

    store.upsertGuildConfig(config('hourly', 240));
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(syncer.syncGuild.mock.calls.map(([id]) => id)).toEqual([
      'hourly', 'two-hourly', 'hourly', 'hourly', 'two-hourly',
    ]);

    store.upsertGuildConfig(config('new-guild', 360));
    await vi.advanceTimersByTimeAsync(30 * 1000);
    expect(syncer.syncGuild.mock.calls.at(-1)?.[0]).toBe('new-guild');
    scheduler.stop();
  });

  it('wakes at the jittered due time even for a one-minute interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    vi.spyOn(Math, 'random').mockReturnValue(0.75); // 1.05 × configured interval
    const store = new InMemoryStore();
    store.upsertGuildConfig(config('minute', 1));
    const syncer = { syncGuild: vi.fn(async (_guildId: string) => []) };
    const scheduler = scheduleGuildSync(store, syncer, 360);

    await vi.advanceTimersByTimeAsync(1);
    expect(syncer.syncGuild).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(62_998);
    expect(syncer.syncGuild).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(syncer.syncGuild).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('bounds simultaneous guild checks and starts a queued guild when a slot opens', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const store = new InMemoryStore();
    const releases: Array<() => void> = [];
    for (let i = 0; i < 5; i++) store.upsertGuildConfig(config(`guild-${i}`, 60));
    const syncer = { syncGuild: vi.fn((_guildId: string) => new Promise<void>((resolve) => {
      releases.push(resolve);
    })) };
    const scheduler = scheduleGuildSync(store, syncer, 360);

    expect(syncer.syncGuild).toHaveBeenCalledTimes(4);
    releases[0]();
    await vi.advanceTimersByTimeAsync(1);
    expect(syncer.syncGuild).toHaveBeenCalledTimes(5);
    scheduler.stop();
    for (const release of releases) release();
    await vi.advanceTimersByTimeAsync(1);
  });
});
