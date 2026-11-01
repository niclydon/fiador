import { requireCallbackOrigin } from './appAuthority.js';

// Environment configuration for the verifier bot.
//
// The bot token lives ONLY in the environment (DESIGN §5.4): it is never
// written to the database, never logged, and never accepted from a slash
// command. loadConfig throws a clear, named error for every missing
// required variable so a self-hoster's first run fails loudly, not weirdly.

export interface BotConfig {
  /** Discord bot token (env only). */
  token: string;
  /** Discord application (client) ID, used to register slash commands. */
  clientId: string;
  /** Default attestation registry URL; per-guild setup can override it. */
  registryUrl: string | null;
  /** World Chain RPC URL for the verify core; null = package default. */
  rpcUrl: string | null;
  /** Path to the SQLite state file. */
  dbPath: string;
  /** Default interval for re-checking legacy bindings, in minutes. */
  syncIntervalMinutes: number;
  /**
   * Exact HTTPS origin serving the application-authority callback page
   * (docs/app-authority.md). Null disables the authority ceremony.
   */
  authorityCallbackOrigin: string | null;
}

export const DEFAULT_SYNC_INTERVAL_MINUTES = 360;
export const DEFAULT_DB_PATH = './data/fiador-verifier.db';

type EnvLike = Record<string, string | undefined>;

function required(env: EnvLike, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Set it in the environment of the bot process (see verifier-bot/README.md).`,
    );
  }
  return value;
}

function optional(env: EnvLike, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

export function loadConfig(env: EnvLike = process.env): BotConfig {
  const syncRaw = optional(env, 'SYNC_INTERVAL_MINUTES');
  let syncIntervalMinutes = DEFAULT_SYNC_INTERVAL_MINUTES;
  if (syncRaw !== null) {
    const parsed = Number(syncRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `Environment variable SYNC_INTERVAL_MINUTES must be a positive number of minutes; got "${syncRaw}".`,
      );
    }
    syncIntervalMinutes = parsed;
  }

  const authorityOriginRaw = optional(env, 'AUTHORITY_CALLBACK_ORIGIN');
  let authorityCallbackOrigin: string | null = null;
  if (authorityOriginRaw !== null) {
    try {
      authorityCallbackOrigin = requireCallbackOrigin(authorityOriginRaw);
    } catch {
      throw new Error(
        `Environment variable AUTHORITY_CALLBACK_ORIGIN must be one exact HTTPS origin ` +
          `(for example "https://fiador.org"); got "${authorityOriginRaw}".`,
      );
    }
  }

  return {
    token: required(env, 'DISCORD_TOKEN'),
    clientId: required(env, 'DISCORD_CLIENT_ID'),
    registryUrl: optional(env, 'REGISTRY_URL'),
    rpcUrl: optional(env, 'RPC_URL'),
    dbPath: optional(env, 'DB_PATH') ?? DEFAULT_DB_PATH,
    syncIntervalMinutes,
    authorityCallbackOrigin,
  };
}
