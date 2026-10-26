import type { Store } from './store.js';

const CHECK_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SYNC_POLL_MS = 30 * 1000;

/** Remove checks older than 90 days, including their wallet and human hash. */
export function pruneExpiredChecks(store: Store, nowMs = Date.now()): number {
  return store.pruneCheckLog(new Date(nowMs - CHECK_LOG_RETENTION_MS).toISOString());
}

/** Prune on startup and once a day while the process remains alive. */
export function startCheckLogPruning(store: Store): NodeJS.Timeout {
  pruneExpiredChecks(store);
  const timer = setInterval(() => {
    try {
      pruneExpiredChecks(store);
    } catch (error) {
      console.error(`fiador: check log pruning failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, PRUNE_INTERVAL_MS);
  timer.unref();
  return timer;
}

interface SyncState {
  lastRunMs: number;
  intervalMs: number;
  dueMs: number;
}

export interface GuildSyncer {
  syncGuild(guildId: string): Promise<unknown>;
}

/**
 * Check each guild only when its own interval is due. The short local poll
 * notices new guilds and setup changes without making extra network calls.
 * Call this after the startup pass, so its first due time starts from that pass.
 */
export function scheduleGuildSync(
  store: Store,
  syncer: GuildSyncer,
  defaultIntervalMinutes: number,
): { stop(): void } {
  const states = new Map<string, SyncState>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const intervalFor = (guildId: string): number =>
    (store.getGuildConfig(guildId)?.syncIntervalMinutes ?? defaultIntervalMinutes) * 60 * 1000;
  const jittered = (intervalMs: number): number =>
    intervalMs * (0.9 + Math.random() * 0.2);

  const startedAt = Date.now();
  for (const guildId of store.listGuildIds()) {
    const intervalMs = intervalFor(guildId);
    states.set(guildId, {
      lastRunMs: startedAt,
      intervalMs,
      dueMs: startedAt + jittered(intervalMs),
    });
  }

  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => { void tick(); }, SYNC_POLL_MS);
    timer.unref();
  };

  const tick = async () => {
    try {
      const guildIds = store.listGuildIds();
      const active = new Set(guildIds);
      for (const guildId of guildIds) {
        const nowMs = Date.now();
        const intervalMs = intervalFor(guildId);
        let state = states.get(guildId);
        if (!state) {
          state = { lastRunMs: nowMs, intervalMs, dueMs: nowMs };
          states.set(guildId, state);
        } else if (state.intervalMs !== intervalMs) {
          state.intervalMs = intervalMs;
          state.dueMs = state.lastRunMs + jittered(intervalMs);
        }
        if (nowMs < state.dueMs) continue;
        try {
          await syncer.syncGuild(guildId);
        } catch (error) {
          console.error(`fiador: sync failed for guild ${guildId}: ${error instanceof Error ? error.message : String(error)}`);
        }
        state.lastRunMs = Date.now();
        state.dueMs = state.lastRunMs + jittered(state.intervalMs);
      }
      for (const guildId of states.keys()) {
        if (!active.has(guildId)) states.delete(guildId);
      }
    } catch (error) {
      console.error(`fiador: sync scheduler failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      arm();
    }
  };

  arm();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
