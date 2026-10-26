// Slash command handlers (DESIGN §5.2).
//
// Handlers are pure with respect to Discord: they take a minimal
// CommandContext (guild, user, permission bit, string options) and return
// a reply payload object. index.ts adapts real discord.js interactions
// to this shape, which is what makes every flow testable without a token.
//
// Commands:
//   /fiador           guild status: bindings, last checks, role members
//   /fiador setup     (Manage Guild) configure role / registry / interval / log channel
//   /verify-agent     one-off check of one application, no state change
//   /attest           operator claim flow: verify, then bind + role decision

import {
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { SignedAttestation } from '@fiador/verify';
import type { DiscordAdapter } from './discordAdapter.js';
import { buildResultEmbed, failureSentence, type EmbedObject } from './embeds.js';
import { RoleSyncEngine } from './roles.js';
import type { Store } from './store.js';
import {
  isSignedAttestation,
  payloadHash,
  VerifyService,
} from './verifyService.js';

export const HUMAN_BACKED_ROLE_NAME = 'Human-backed';

export interface CommandContext {
  guildId: string;
  userId: string;
  hasManageGuild: boolean;
  getOption(name: string): string | null;
}

export interface ReplyPayload {
  ephemeral: boolean;
  content?: string;
  embeds?: EmbedObject[];
}

export interface CommandDeps {
  service: VerifyService;
  store: Store;
  adapter: DiscordAdapter;
  sync: RoleSyncEngine;
  rateLimiter: AttemptRateLimiter;
  defaultSyncIntervalMinutes: number;
}

/** /attest rate limit (DESIGN §5.4): 5 attempts / user / guild / 10 min. */
export class AttemptRateLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly limit = 5,
    private readonly windowMs = 10 * 60 * 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Records an attempt; returns false when the caller is over the limit. */
  tryAcquire(key: string): boolean {
    const nowMs = this.now();
    const recent = (this.attempts.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.attempts.set(key, recent);
      return false;
    }
    recent.push(nowMs);
    this.attempts.set(key, recent);
    return true;
  }
}

export function buildCommandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const fiador = new SlashCommandBuilder()
    .setName('fiador')
    .setDescription('Fiador status and setup for this server')
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Show bound bots and their last check results'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Configure the Human-backed role, registry, and sync (Manage Guild)')
        // Note: enforced at runtime in handleFiadorSetup via the
        // caller's Manage Guild permission — subcommand builders have
        // no default-permissions API in discord.js v14.
        .addStringOption((opt) =>
          opt.setName('role_id').setDescription('Existing role ID to use as the Human-backed role'),
        )
        .addStringOption((opt) =>
          opt.setName('registry_url').setDescription('Attestation registry URL for discovery'),
        )
        .addIntegerOption((opt) =>
          opt.setName('sync_interval_minutes').setDescription('Role sync interval in minutes'),
        )
        .addStringOption((opt) =>
          opt.setName('log_channel_id').setDescription('Channel ID for grant/revoke log lines'),
        ),
    );

  const verifyAgent = new SlashCommandBuilder()
    .setName('verify-agent')
    .setDescription('Check one bot against its Fiador attestation (no changes made)')
    .addStringOption((opt) =>
      opt
        .setName('application_id')
        .setDescription('Discord application ID of the bot to check')
        .setRequired(true),
    );

  const attest = new SlashCommandBuilder()
    .setName('attest')
    .setDescription('Bind a bot to this server by verifying its signed Fiador attestation')
    .addStringOption((opt) =>
      opt.setName('url').setDescription('URL where the signed attestation JSON is hosted'),
    )
    .addStringOption((opt) =>
      opt.setName('attestation').setDescription('The signed attestation JSON, pasted directly'),
    );

  return [fiador.toJSON(), verifyAgent.toJSON(), attest.toJSON()];
}

function ephemeral(content: string): ReplyPayload {
  return { ephemeral: true, content };
}

export async function handleFiadorStatus(
  ctx: CommandContext,
  deps: CommandDeps,
): Promise<ReplyPayload> {
  const config = deps.store.getGuildConfig(ctx.guildId);
  const bindings = deps.store.listBindings(ctx.guildId);
  const lines: string[] = [];

  if (!config?.roleId) {
    lines.push(
      `No Human-backed role is configured yet — an admin can run \`/fiador setup\`. (The role is named "${HUMAN_BACKED_ROLE_NAME}" by default and tracked by ID, so it can be renamed freely.)`,
    );
  } else {
    const count = await deps.adapter.getRoleMemberCount(ctx.guildId, config.roleId);
    lines.push(`Human-backed role: <@&${config.roleId}> — ${count} member(s).`);
  }
  lines.push(
    `Sync interval: ${config?.syncIntervalMinutes ?? deps.defaultSyncIntervalMinutes} minutes. Registry: ${config?.registryUrl ?? '(instance default)'}.`,
  );

  if (bindings.length === 0) {
    lines.push('No bots are bound in this server yet. An operator can bind one with `/attest`.');
  } else {
    lines.push('Bound bots:');
    for (const binding of bindings) {
      const last = deps.store.getLatestCheck(ctx.guildId, binding.applicationId);
      lines.push(
        last
          ? `• Application ${binding.applicationId} — last check: **${last.status}** at ${last.checkedAt}`
          : `• Application ${binding.applicationId} — not checked yet`,
      );
    }
  }
  return ephemeral(lines.join('\n'));
}

export async function handleFiadorSetup(
  ctx: CommandContext,
  deps: CommandDeps,
): Promise<ReplyPayload> {
  if (!ctx.hasManageGuild) {
    return ephemeral('`/fiador setup` requires the Manage Guild permission.');
  }
  const existing = deps.store.getGuildConfig(ctx.guildId);
  const syncRaw = ctx.getOption('sync_interval_minutes');
  let syncIntervalMinutes =
    existing?.syncIntervalMinutes ?? deps.defaultSyncIntervalMinutes;
  if (syncRaw !== null) {
    const parsed = Number(syncRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return ephemeral('`sync_interval_minutes` must be a positive whole number of minutes.');
    }
    syncIntervalMinutes = parsed;
  }
  const config = {
    guildId: ctx.guildId,
    roleId: ctx.getOption('role_id') ?? existing?.roleId ?? null,
    registryUrl: ctx.getOption('registry_url') ?? existing?.registryUrl ?? null,
    syncIntervalMinutes,
    logChannelId: ctx.getOption('log_channel_id') ?? existing?.logChannelId ?? null,
  };
  deps.store.upsertGuildConfig(config);
  return ephemeral(
    [
      'Fiador setup saved for this server.',
      `• Human-backed role ID: ${config.roleId ?? '(not set — create a role named "Human-backed" and pass its ID)'}`,
      `• Registry URL: ${config.registryUrl ?? '(instance default)'}`,
      `• Sync interval: ${config.syncIntervalMinutes} minutes`,
      `• Log channel ID: ${config.logChannelId ?? '(none)'}`,
      'Note: the bot role must sit above the Human-backed role in the role hierarchy and hold Manage Roles, or grants will fail.',
    ].join('\n'),
  );
}

export async function handleVerifyAgent(
  ctx: CommandContext,
  deps: CommandDeps,
): Promise<ReplyPayload> {
  const applicationId = ctx.getOption('application_id');
  if (!applicationId) {
    return ephemeral('Provide an `application_id` to check.');
  }
  const outcome = await deps.service.checkApplication(ctx.guildId, applicationId);
  return {
    ephemeral: true,
    embeds: [
      buildResultEmbed({
        applicationId,
        result: outcome.result,
        attestation: outcome.attestation,
      }),
    ],
  };
}

export async function handleAttest(
  ctx: CommandContext,
  deps: CommandDeps,
): Promise<ReplyPayload> {
  if (!deps.rateLimiter.tryAcquire(`${ctx.guildId}:${ctx.userId}`)) {
    return ephemeral('Too many /attest attempts — try again in a few minutes.');
  }

  const url = ctx.getOption('url');
  const pasted = ctx.getOption('attestation');
  if (!url && !pasted) {
    return ephemeral('Provide either a `url` where the attestation is hosted, or paste the `attestation` JSON.');
  }

  let attestation: SignedAttestation;
  let attestationUrl: string;
  try {
    if (url) {
      attestation = await deps.service.fetchAttestation(url);
      attestationUrl = url;
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(pasted as string);
      } catch {
        return ephemeral('The pasted attestation is not valid JSON.');
      }
      if (!isSignedAttestation(parsed)) {
        return ephemeral('The pasted document is not a signed Fiador attestation.');
      }
      attestation = parsed;
      attestationUrl = parsed.payload.attestationUrl ?? 'paste';
    }
  } catch (err) {
    return ephemeral(
      `Could not fetch that attestation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (attestation.payload.subject.type !== 'discord_application') {
    return ephemeral('This attestation is not for a Discord application, so it cannot be bound here.');
  }
  const applicationId = attestation.payload.subject.id;

  // The cryptography, not the caller, is the gate (DESIGN §5.2): anyone
  // may run /attest, but a binding — and any role change — only ever
  // follows a passing verify. On failure: report, store nothing.
  const outcome = await deps.service.checkAttestation(ctx.guildId, attestation);
  const embed = buildResultEmbed({
    applicationId,
    result: outcome.result,
    attestation,
  });
  if (outcome.result.status !== 'verified') {
    const sentence = outcome.result.failures.map(failureSentence).join(' ');
    return {
      ephemeral: true,
      content: `Attestation for application ${applicationId} did not verify, so nothing was bound. ${sentence}`.trim(),
      embeds: [embed],
    };
  }

  const botUserId =
    outcome.botUserId ??
    (await deps.adapter.resolveBotUserId(ctx.guildId, applicationId));
  const binding = {
    guildId: ctx.guildId,
    applicationId,
    attestationUrl,
    payloadHash: payloadHash(attestation),
    boundVia: url ? 'url' : 'paste',
    boundBy: ctx.userId,
    boundAt: new Date().toISOString(),
    botUserId,
  };
  deps.store.upsertBinding(binding);

  const report = await deps.sync.applyOutcome(ctx.guildId, binding, outcome);
  const roleNote = !report.note
    ? report.changed
      ? ' The Human-backed role was granted.'
      : ' The Human-backed role is already in place.'
    : ` Role: ${report.note}`;
  return {
    ephemeral: true,
    content: `Bound application ${applicationId} to this server.${roleNote}`,
    embeds: [embed],
  };
}
