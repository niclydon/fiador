// Guild state store (DESIGN §5.1).
//
// One SQLite file on the self-hoster's machine holds everything the bot
// remembers: per-guild configuration, application bindings, and an
// append-only check log. The Store interface is the seam: production uses
// SqliteStore (node:sqlite), tests use InMemoryStore. No hosted database,
// no external service.
//
// check_log stores the package's VerificationStatus verbatim so `unknown`
// (the check itself failed) and `unregistered` (checked live, no entry)
// stay distinct in the guild's own history, exactly as in the result.

import { DatabaseSync } from 'node:sqlite';
import type { FailureCode, VerificationStatus } from '@fiador/verify';

export interface GuildConfigRow {
  guildId: string;
  /** Role ID of the "Human-backed" role (tracked by ID; guilds may rename). */
  roleId: string | null;
  registryUrl: string | null;
  syncIntervalMinutes: number;
  logChannelId: string | null;
}

export interface Binding {
  guildId: string;
  applicationId: string;
  attestationUrl: string;
  /** sha256 of the canonical payload bytes, as bound. Null for legacy rows. */
  payloadHash: string | null;
  /** 'url' | 'paste' | 'registry' | 'join' — how the binding was created. */
  boundVia: string;
  boundBy: string;
  boundAt: string;
  /** The bot user ID that receives the role, when known. */
  botUserId: string | null;
}

/** A one-use observation request, not proof that a wallet controls an app. */
export interface ControlChallenge {
  nonce: string;
  guildId: string;
  channelId: string;
  verifierBotUserId: string;
  applicationId: string;
  botUserId: string;
  wallet: `0x${string}`;
  payloadHash: string;
  attestationUrl: string;
  issuedAt: string;
  expiresAt: string;
  consumedAt: string | null;
  messageId: string | null;
}

export interface CheckLogEntry {
  id?: number;
  guildId: string;
  applicationId: string;
  checkedAt: string;
  status: VerificationStatus;
  failures: FailureCode[];
  wallet: string | null;
  humanHash: string | null;
  expiresAt: string | null;
}

export interface Store {
  getGuildConfig(guildId: string): GuildConfigRow | null;
  upsertGuildConfig(config: GuildConfigRow): void;
  listGuildIds(): string[];
  getBinding(guildId: string, applicationId: string): Binding | null;
  listBindings(guildId: string): Binding[];
  upsertBinding(binding: Binding): void;
  removeBinding(guildId: string, applicationId: string): void;
  saveControlChallenge(challenge: ControlChallenge): void;
  getControlChallenge(nonce: string): ControlChallenge | null;
  /** Atomically consume one still-live challenge. Returns false on replay/expiry. */
  consumeControlChallenge(nonce: string, consumedAt: string, messageId: string): boolean;
  /** Remove expired witness rows after their short operational retention window. */
  pruneControlChallenges(expiredBeforeIso: string): number;
  appendCheckLog(entry: CheckLogEntry): void;
  getLatestCheck(guildId: string, applicationId: string): CheckLogEntry | null;
  listCheckLog(guildId: string, applicationId?: string): CheckLogEntry[];
  /** Append-only log hygiene (DESIGN §5.1: prune by age, default 90 days). */
  pruneCheckLog(olderThanIso: string): number;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT PRIMARY KEY,
  role_id TEXT,
  registry_url TEXT,
  sync_interval_minutes INTEGER NOT NULL DEFAULT 360,
  log_channel_id TEXT
);
CREATE TABLE IF NOT EXISTS binding (
  guild_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  attestation_url TEXT NOT NULL,
  payload_hash TEXT,
  bound_via TEXT NOT NULL,
  bound_by TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  bot_user_id TEXT,
  PRIMARY KEY (guild_id, application_id)
);
CREATE TABLE IF NOT EXISTS check_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  status TEXT NOT NULL,
  failures_json TEXT NOT NULL DEFAULT '[]',
  wallet TEXT,
  human_hash TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS check_log_lookup
  ON check_log (guild_id, application_id, id DESC);
CREATE TABLE IF NOT EXISTS control_challenge (
  nonce TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  verifier_bot_user_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  bot_user_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  attestation_url TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  message_id TEXT
);
`;

interface GuildConfigDbRow {
  guild_id: string;
  role_id: string | null;
  registry_url: string | null;
  sync_interval_minutes: number;
  log_channel_id: string | null;
}

interface BindingDbRow {
  guild_id: string;
  application_id: string;
  attestation_url: string;
  payload_hash: string | null;
  bound_via: string;
  bound_by: string;
  bound_at: string;
  bot_user_id: string | null;
}

interface ControlChallengeDbRow {
  nonce: string;
  guild_id: string;
  channel_id: string;
  verifier_bot_user_id: string;
  application_id: string;
  bot_user_id: string;
  wallet: `0x${string}`;
  payload_hash: string;
  attestation_url: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  message_id: string | null;
}

function toControlChallenge(row: ControlChallengeDbRow): ControlChallenge {
  return {
    nonce: row.nonce,
    guildId: row.guild_id,
    channelId: row.channel_id,
    verifierBotUserId: row.verifier_bot_user_id,
    applicationId: row.application_id,
    botUserId: row.bot_user_id,
    wallet: row.wallet,
    payloadHash: row.payload_hash,
    attestationUrl: row.attestation_url,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    messageId: row.message_id,
  };
}

interface CheckLogDbRow {
  id: number;
  guild_id: string;
  application_id: string;
  checked_at: string;
  status: string;
  failures_json: string;
  wallet: string | null;
  human_hash: string | null;
  expires_at: string | null;
}

function toGuildConfig(row: GuildConfigDbRow): GuildConfigRow {
  return {
    guildId: row.guild_id,
    roleId: row.role_id,
    registryUrl: row.registry_url,
    syncIntervalMinutes: row.sync_interval_minutes,
    logChannelId: row.log_channel_id,
  };
}

function toBinding(row: BindingDbRow): Binding {
  return {
    guildId: row.guild_id,
    applicationId: row.application_id,
    attestationUrl: row.attestation_url,
    payloadHash: row.payload_hash,
    boundVia: row.bound_via,
    boundBy: row.bound_by,
    boundAt: row.bound_at,
    botUserId: row.bot_user_id,
  };
}

function toCheckLogEntry(row: CheckLogDbRow): CheckLogEntry {
  return {
    id: row.id,
    guildId: row.guild_id,
    applicationId: row.application_id,
    checkedAt: row.checked_at,
    status: row.status as VerificationStatus,
    failures: JSON.parse(row.failures_json) as FailureCode[],
    wallet: row.wallet,
    humanHash: row.human_hash,
    expiresAt: row.expires_at,
  };
}

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  getGuildConfig(guildId: string): GuildConfigRow | null {
    const row = this.db
      .prepare('SELECT * FROM guild_config WHERE guild_id = ?')
      .get(guildId) as GuildConfigDbRow | undefined;
    return row ? toGuildConfig(row) : null;
  }

  upsertGuildConfig(config: GuildConfigRow): void {
    this.db
      .prepare(
        `INSERT INTO guild_config (guild_id, role_id, registry_url, sync_interval_minutes, log_channel_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (guild_id) DO UPDATE SET
           role_id = excluded.role_id,
           registry_url = excluded.registry_url,
           sync_interval_minutes = excluded.sync_interval_minutes,
           log_channel_id = excluded.log_channel_id`,
      )
      .run(
        config.guildId,
        config.roleId,
        config.registryUrl,
        config.syncIntervalMinutes,
        config.logChannelId,
      );
  }

  listGuildIds(): string[] {
    const rows = this.db
      .prepare('SELECT guild_id FROM guild_config UNION SELECT guild_id FROM binding ORDER BY guild_id')
      .all() as unknown as { guild_id: string }[];
    return rows.map((r) => r.guild_id);
  }

  getBinding(guildId: string, applicationId: string): Binding | null {
    const row = this.db
      .prepare('SELECT * FROM binding WHERE guild_id = ? AND application_id = ?')
      .get(guildId, applicationId) as BindingDbRow | undefined;
    return row ? toBinding(row) : null;
  }

  listBindings(guildId: string): Binding[] {
    const rows = this.db
      .prepare('SELECT * FROM binding WHERE guild_id = ? ORDER BY application_id')
      .all(guildId) as unknown as BindingDbRow[];
    return rows.map(toBinding);
  }

  upsertBinding(binding: Binding): void {
    this.db
      .prepare(
        `INSERT INTO binding (guild_id, application_id, attestation_url, payload_hash, bound_via, bound_by, bound_at, bot_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, application_id) DO UPDATE SET
           attestation_url = excluded.attestation_url,
           payload_hash = excluded.payload_hash,
           bound_via = excluded.bound_via,
           bound_by = excluded.bound_by,
           bound_at = excluded.bound_at,
           bot_user_id = excluded.bot_user_id`,
      )
      .run(
        binding.guildId,
        binding.applicationId,
        binding.attestationUrl,
        binding.payloadHash,
        binding.boundVia,
        binding.boundBy,
        binding.boundAt,
        binding.botUserId,
      );
  }

  removeBinding(guildId: string, applicationId: string): void {
    this.db
      .prepare('DELETE FROM binding WHERE guild_id = ? AND application_id = ?')
      .run(guildId, applicationId);
  }

  saveControlChallenge(challenge: ControlChallenge): void {
    this.db.prepare(
      `INSERT INTO control_challenge
       (nonce, guild_id, channel_id, verifier_bot_user_id, application_id, bot_user_id,
        wallet, payload_hash, attestation_url, issued_at, expires_at, consumed_at, message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      challenge.nonce, challenge.guildId, challenge.channelId, challenge.verifierBotUserId,
      challenge.applicationId, challenge.botUserId, challenge.wallet, challenge.payloadHash,
      challenge.attestationUrl, challenge.issuedAt, challenge.expiresAt,
    );
  }

  getControlChallenge(nonce: string): ControlChallenge | null {
    const row = this.db.prepare('SELECT * FROM control_challenge WHERE nonce = ?')
      .get(nonce) as ControlChallengeDbRow | undefined;
    return row ? toControlChallenge(row) : null;
  }

  consumeControlChallenge(nonce: string, consumedAt: string, messageId: string): boolean {
    const changed = this.db.prepare(
      `UPDATE control_challenge SET consumed_at = ?, message_id = ?
       WHERE nonce = ? AND consumed_at IS NULL AND issued_at <= ? AND expires_at > ?`,
    ).run(consumedAt, messageId, nonce, consumedAt, consumedAt);
    return Number(changed.changes) === 1;
  }

  pruneControlChallenges(expiredBeforeIso: string): number {
    return Number(this.db.prepare('DELETE FROM control_challenge WHERE expires_at < ?')
      .run(expiredBeforeIso).changes);
  }

  appendCheckLog(entry: CheckLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO check_log (guild_id, application_id, checked_at, status, failures_json, wallet, human_hash, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.guildId,
        entry.applicationId,
        entry.checkedAt,
        entry.status,
        JSON.stringify(entry.failures),
        entry.wallet,
        entry.humanHash,
        entry.expiresAt,
      );
  }

  getLatestCheck(guildId: string, applicationId: string): CheckLogEntry | null {
    const row = this.db
      .prepare(
        'SELECT * FROM check_log WHERE guild_id = ? AND application_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(guildId, applicationId) as CheckLogDbRow | undefined;
    return row ? toCheckLogEntry(row) : null;
  }

  listCheckLog(guildId: string, applicationId?: string): CheckLogEntry[] {
    const rows = (
      applicationId
        ? this.db
            .prepare(
              'SELECT * FROM check_log WHERE guild_id = ? AND application_id = ? ORDER BY id DESC',
            )
            .all(guildId, applicationId)
        : this.db
            .prepare('SELECT * FROM check_log WHERE guild_id = ? ORDER BY id DESC')
            .all(guildId)
    ) as unknown as CheckLogDbRow[];
    return rows.map(toCheckLogEntry);
  }

  pruneCheckLog(olderThanIso: string): number {
    const result = this.db
      .prepare('DELETE FROM check_log WHERE checked_at < ?')
      .run(olderThanIso);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}

/** In-memory Store for tests and dry runs. Same semantics, no disk. */
export class InMemoryStore implements Store {
  private readonly configs = new Map<string, GuildConfigRow>();
  private readonly bindings = new Map<string, Binding>();
  private readonly controlChallenges = new Map<string, ControlChallenge>();
  private readonly checks: CheckLogEntry[] = [];
  private nextId = 1;

  private static bindingKey(guildId: string, applicationId: string): string {
    return `${guildId}:${applicationId}`;
  }

  getGuildConfig(guildId: string): GuildConfigRow | null {
    return this.configs.get(guildId) ?? null;
  }

  upsertGuildConfig(config: GuildConfigRow): void {
    this.configs.set(config.guildId, { ...config });
  }

  listGuildIds(): string[] {
    return [...new Set([
      ...this.configs.keys(),
      ...[...this.bindings.values()].map((binding) => binding.guildId),
    ])].sort();
  }

  getBinding(guildId: string, applicationId: string): Binding | null {
    return this.bindings.get(InMemoryStore.bindingKey(guildId, applicationId)) ?? null;
  }

  listBindings(guildId: string): Binding[] {
    return [...this.bindings.values()]
      .filter((b) => b.guildId === guildId)
      .sort((a, b) => a.applicationId.localeCompare(b.applicationId));
  }

  upsertBinding(binding: Binding): void {
    this.bindings.set(InMemoryStore.bindingKey(binding.guildId, binding.applicationId), {
      ...binding,
    });
  }

  removeBinding(guildId: string, applicationId: string): void {
    this.bindings.delete(InMemoryStore.bindingKey(guildId, applicationId));
  }

  saveControlChallenge(challenge: ControlChallenge): void {
    if (this.controlChallenges.has(challenge.nonce)) throw new Error('Challenge nonce already exists.');
    this.controlChallenges.set(challenge.nonce, { ...challenge, consumedAt: null, messageId: null });
  }

  getControlChallenge(nonce: string): ControlChallenge | null {
    const challenge = this.controlChallenges.get(nonce);
    return challenge ? { ...challenge } : null;
  }

  consumeControlChallenge(nonce: string, consumedAt: string, messageId: string): boolean {
    const challenge = this.controlChallenges.get(nonce);
    if (!challenge || challenge.consumedAt || consumedAt < challenge.issuedAt || consumedAt >= challenge.expiresAt) return false;
    this.controlChallenges.set(nonce, { ...challenge, consumedAt, messageId });
    return true;
  }

  pruneControlChallenges(expiredBeforeIso: string): number {
    let count = 0;
    for (const [nonce, challenge] of this.controlChallenges) {
      if (challenge.expiresAt < expiredBeforeIso) {
        this.controlChallenges.delete(nonce);
        count++;
      }
    }
    return count;
  }

  appendCheckLog(entry: CheckLogEntry): void {
    this.checks.push({ ...entry, id: this.nextId++, failures: [...entry.failures] });
  }

  getLatestCheck(guildId: string, applicationId: string): CheckLogEntry | null {
    for (let i = this.checks.length - 1; i >= 0; i--) {
      const entry = this.checks[i];
      if (entry.guildId === guildId && entry.applicationId === applicationId) return entry;
    }
    return null;
  }

  listCheckLog(guildId: string, applicationId?: string): CheckLogEntry[] {
    return this.checks
      .filter(
        (e) =>
          e.guildId === guildId &&
          (applicationId === undefined || e.applicationId === applicationId),
      )
      .reverse();
  }

  pruneCheckLog(olderThanIso: string): number {
    const before = this.checks.length;
    for (let i = this.checks.length - 1; i >= 0; i--) {
      if (this.checks[i].checkedAt < olderThanIso) this.checks.splice(i, 1);
    }
    return before - this.checks.length;
  }

  close(): void {
    // Nothing to release.
  }
}
