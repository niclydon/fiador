import type { Store } from './store.js';

const CHECK_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const GUILD_DISCOVERY_MS = 30 * 1000;
const MAX_CONCURRENT_GUILD_SYNCS = 4;

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
  lastRunMs: number | null;
  intervalMs: number;
  dueMs: number;
  inFlight: boolean;
  firstSync: boolean;
}

export interface GuildSyncer {
  syncGuild(guildId: string): Promise<unknown>;
}

/**
 * Start each guild's first check at startup, then use its own interval for
 * later checks. One timer wakes at the next due time; a local discovery
 * timer also notices new guilds and setup changes without network calls.
 * Slow checks hold only their own guild slot, up to the concurrency cap.
 */
export function scheduleGuildSync(
  store: Store,
  syncer: GuildSyncer,
  defaultIntervalMinutes: number,
  beforeFirstSync?: (guildId: string) => Promise<void>,
): { stop(): void } {
  const states = new Map<string, SyncState>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let activeSyncs = 0;

  const intervalFor = (guildId: string): number => {
    const configured = store.getGuildConfig(guildId)?.syncIntervalMinutes ?? defaultIntervalMinutes;
    const minutes = Number.isFinite(configured) && configured > 0
      ? configured : defaultIntervalMinutes;
    return minutes * 60 * 1000;
  };
  const jittered = (intervalMs: number): number =>
    intervalMs * (0.9 + Math.random() * 0.2);

  const tick = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    try {
      const guildIds = store.listGuildIds();
      const active = new Set(guildIds);
      for (const guildId of guildIds) {
        const nowMs = Date.now();
        const intervalMs = intervalFor(guildId);
        let state = states.get(guildId);
        if (!state) {
          state = {
            lastRunMs: null,
            intervalMs,
            dueMs: nowMs,
            inFlight: false,
            firstSync: true,
          };
          states.set(guildId, state);
        } else if (state.intervalMs !== intervalMs) {
          state.intervalMs = intervalMs;
          if (!state.inFlight && state.lastRunMs !== null) {
            state.dueMs = state.lastRunMs + jittered(intervalMs);
          }
        }
        if (activeSyncs >= MAX_CONCURRENT_GUILD_SYNCS ||
            state.inFlight || nowMs < state.dueMs) continue;
        state.inFlight = true;
        activeSyncs++;
        void runSync(guildId, state);
      }
      for (const guildId of states.keys()) {
        if (!active.has(guildId) && !states.get(guildId)?.inFlight) states.delete(guildId);
      }
    } catch (error) {
      console.error(`fiador: sync scheduler failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!stopped) {
        const nowMs = Date.now();
        let nextWakeMs = nowMs + GUILD_DISCOVERY_MS;
        if (activeSyncs < MAX_CONCURRENT_GUILD_SYNCS) {
          for (const state of states.values()) {
            if (!state.inFlight) nextWakeMs = Math.min(nextWakeMs, state.dueMs);
          }
        }
        timer = setTimeout(tick, Math.max(1, Math.ceil(nextWakeMs - nowMs)));
        timer.unref();
      }
    }
  };

  const runSync = async (guildId: string, state: SyncState) => {
    try {
      if (state.firstSync && beforeFirstSync) {
        try {
          await beforeFirstSync(guildId);
        } catch (error) {
          console.error(`fiador: startup audit failed for guild ${guildId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await syncer.syncGuild(guildId);
    } catch (error) {
      console.error(`fiador: sync failed for guild ${guildId}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      state.inFlight = false;
      state.firstSync = false;
      activeSyncs--;
      state.lastRunMs = Date.now();
      state.dueMs = state.lastRunMs + jittered(state.intervalMs);
      tick();
    }
  };

  tick();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
