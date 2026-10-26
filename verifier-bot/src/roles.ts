// Attestation checks and the parked role sync engine. The verifier can
// establish that a registered wallet signed a claim about an application,
// but it cannot yet establish control of that Discord application. Until
// a trusted app-control challenge exists, every status keeps role state.
// `unknown` still retries once and warns on a second failure.

import type { VerificationStatus } from '@fiador/verify';
import type { DiscordAdapter } from './discordAdapter.js';
import type { Binding, Store } from './store.js';
import type { CheckOutcome, VerifyService } from './verifyService.js';

export type RoleAction = 'grant' | 'revoke' | 'keep';

export function decideRoleAction(_status: VerificationStatus): RoleAction {
  // The signed claim and its self-asserted bot ID are not app-control proof.
  return 'keep';
}

export const UNKNOWN_RETRY_DELAY_MS = 15 * 60 * 1000;

/** Announce the upgrade risk once per guild at startup, before any re-checks. */
export async function warnLegacyRoleAudit(
  guildId: string,
  store: Store,
  adapter: DiscordAdapter,
  warn: (line: string) => void = console.warn,
): Promise<void> {
  const claimCount = store.listBindings(guildId).length;
  if (claimCount === 0) return;
  const line =
    `FIADOR ADMIN AUDIT REQUIRED for guild ${guildId}: ${claimCount} stored legacy operator claim(s) do not prove Discord application control. ` +
    'Manually review every existing Human-backed role holder and remove unsupported roles. Fiador will not grant or revoke roles.';
  // A process warning survives a missing or misconfigured log channel.
  warn(line);
  if (store.getGuildConfig(guildId)?.logChannelId) {
    try {
      await adapter.sendLogLine(guildId, line);
    } catch (error) {
      warn(`Fiador could not post the role-audit warning to the configured log channel for guild ${guildId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export interface BindingSyncReport {
  applicationId: string;
  status: VerificationStatus;
  action: RoleAction;
  /** True when the role state actually changed on Discord. */
  changed: boolean;
  /** True when this binding hit its second consecutive `unknown`. */
  unknownWarning: boolean;
  note?: string;
}

export interface SyncEngineDeps {
  store: Store;
  service: VerifyService;
  adapter: DiscordAdapter;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  unknownRetryDelayMs?: number;
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export class RoleSyncEngine {
  private readonly store: Store;
  private readonly service: VerifyService;
  private readonly adapter: DiscordAdapter;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly unknownRetryDelayMs: number;
  private readonly consecutiveUnknowns = new Map<string, number>();

  constructor(deps: SyncEngineDeps) {
    this.store = deps.store;
    this.service = deps.service;
    this.adapter = deps.adapter;
    this.sleep = deps.sleep ?? realSleep;
    this.unknownRetryDelayMs = deps.unknownRetryDelayMs ?? UNKNOWN_RETRY_DELAY_MS;
  }

  private static key(guildId: string, applicationId: string): string {
    return `${guildId}:${applicationId}`;
  }

  /**
   * Apply an already-computed check outcome to the role. Used by the
   * /attest flow, where the check has just run and must not run twice.
   */
  async applyOutcome(
    guildId: string,
    binding: Binding,
    outcome: CheckOutcome,
  ): Promise<BindingSyncReport> {
    const action = decideRoleAction(outcome.result.status);
    const key = RoleSyncEngine.key(guildId, binding.applicationId);

    if (outcome.result.status === 'unknown') {
      const count = (this.consecutiveUnknowns.get(key) ?? 0) + 1;
      this.consecutiveUnknowns.set(key, count);
      return {
        applicationId: binding.applicationId,
        status: outcome.result.status,
        action,
        changed: false,
        unknownWarning: count >= 2,
      };
    }
    this.consecutiveUnknowns.delete(key);

    return {
      applicationId: binding.applicationId,
      status: outcome.result.status,
      action,
      changed: false,
      unknownWarning: false,
      note: 'Discord application control is unproven; Human-backed role sync is disabled.',
    };
  }

  /**
   * Check one binding and apply the outcome. On `unknown`, waits the
   * retry delay (injectable) and checks exactly once more before
   * deciding — the second result is what gets applied and logged.
   */
  async syncBinding(guildId: string, binding: Binding): Promise<BindingSyncReport> {
    let outcome = await this.service.checkApplication(guildId, binding.applicationId);
    let retried = false;
    if (outcome.result.status === 'unknown') {
      await this.sleep(this.unknownRetryDelayMs);
      outcome = await this.service.checkApplication(guildId, binding.applicationId);
      retried = true;
    }
    const report = await this.applyOutcome(guildId, binding, outcome);
    // A check that was already a retry and still came back `unknown` IS
    // the second consecutive unknown, even within a single sync pass.
    const unknownWarning =
      report.unknownWarning || (retried && report.status === 'unknown');
    if (unknownWarning) {
      await this.adapter.sendLogLine(
        guildId,
        `Fiador: warning — checks for application ${binding.applicationId} have returned "unknown" twice in a row. No role change made; the lookup itself is failing.`,
      );
    }
    return { ...report, unknownWarning };
  }

  /** Full-guild sync pass: every binding, in binding order. */
  async syncGuild(guildId: string): Promise<BindingSyncReport[]> {
    const reports: BindingSyncReport[] = [];
    for (const binding of this.store.listBindings(guildId)) {
      reports.push(await this.syncBinding(guildId, binding));
    }
    return reports;
  }
}
