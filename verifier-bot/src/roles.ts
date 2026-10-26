// Role decisions and the sync engine (DESIGN §5.5).
//
// The asymmetry at the heart of this module is deliberate:
//   verified                       -> grant
//   invalid | expired | unregistered -> revoke (the claim itself failed)
//   unknown                        -> keep   (the CHECK failed, not the claim)
//
// `unknown` revokes nothing, ever. A transient RPC outage must not
// mass-revoke a guild; chain unavailability is our problem, a lapsed
// attestation is the operator's. An `unknown` binding retries once after
// 15 minutes; a second consecutive `unknown` raises a log-channel
// warning instead of a revocation.

import type { VerificationStatus } from '@fiador/verify';
import type { DiscordAdapter } from './discordAdapter.js';
import { failureSentence } from './embeds.js';
import type { Binding, Store } from './store.js';
import type { CheckOutcome, VerifyService } from './verifyService.js';

export type RoleAction = 'grant' | 'revoke' | 'keep';

export function decideRoleAction(status: VerificationStatus): RoleAction {
  switch (status) {
    case 'verified':
      return 'grant';
    case 'invalid':
    case 'expired':
    case 'unregistered':
      return 'revoke';
    case 'unknown':
      return 'keep';
  }
}

export const UNKNOWN_RETRY_DELAY_MS = 15 * 60 * 1000;

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
    const config = this.store.getGuildConfig(guildId);
    const roleId = config?.roleId ?? null;
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

    if (!roleId) {
      return {
        applicationId: binding.applicationId,
        status: outcome.result.status,
        action,
        changed: false,
        unknownWarning: false,
        note: 'No Human-backed role configured for this guild; run /fiador setup.',
      };
    }

    const botUserId =
      binding.botUserId ??
      outcome.botUserId ??
      (await this.adapter.resolveBotUserId(guildId, binding.applicationId));
    if (!botUserId) {
      return {
        applicationId: binding.applicationId,
        status: outcome.result.status,
        action,
        changed: false,
        unknownWarning: false,
        note: 'Could not resolve the bot user for this application in this guild.',
      };
    }

    const hasRole = await this.adapter.memberHasRole(guildId, botUserId, roleId);
    let changed = false;
    if (action === 'grant' && !hasRole) {
      await this.adapter.grantRole(
        guildId,
        botUserId,
        roleId,
        'Fiador: attestation verified against AgentBook.',
      );
      changed = true;
    } else if (action === 'revoke' && hasRole) {
      const sentence = outcome.result.failures.map(failureSentence).join(' ');
      await this.adapter.revokeRole(
        guildId,
        botUserId,
        roleId,
        `Fiador: ${outcome.result.status}. ${sentence}`.trim(),
      );
      changed = true;
    }

    if (changed) {
      await this.adapter.sendLogLine(
        guildId,
        `Fiador: ${action === 'grant' ? 'granted' : 'revoked'} Human-backed for application ${binding.applicationId} (${outcome.result.status}).`,
      );
    }

    return {
      applicationId: binding.applicationId,
      status: outcome.result.status,
      action,
      changed,
      unknownWarning: false,
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
