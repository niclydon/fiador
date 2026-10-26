// Slash command handlers (DESIGN §5.2).
//
// Handlers are pure with respect to Discord: they take a minimal
// CommandContext (guild, user, permission bit, string options) and return
// a reply payload object. index.ts adapts real discord.js interactions
// to this shape, which is what makes every flow testable without a token.
//
// Commands:
//   /fiador status    paged legacy claims, last checks, manual role audit
//   /fiador setup     (Manage Guild) configure role / registry / interval / log channel
//   /fiador control-start, control-complete  limited bot-response witness
//   /verify-agent     one-off check of one application, no state change
//   /attest           operator claim check; app control remains unproven

import {
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { SignedAttestation } from '@fiador/verify';
import type { DiscordAdapter } from './discordAdapter.js';
import { canonicalBotResponseText, canonicalChallengeText, type AppControlService } from './appControl.js';
import { buildResultEmbed, failureSentence, type EmbedObject } from './embeds.js';
import { RoleSyncEngine } from './roles.js';
import type { Store } from './store.js';
import {
  isSignedAttestation,
  VerifyService,
} from './verifyService.js';

export const HUMAN_BACKED_ROLE_NAME = 'Human-backed';
const STATUS_PAGE_SIZE = 6;

function statusField(value: string, limit: number): string {
  const oneLine = value.replace(/[\r\n\t]/g, ' ').replace(/@/g, '＠');
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

export interface CommandContext {
  guildId: string;
  channelId: string;
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
  appControl?: AppControlService;
}

/** Shared /attest and /verify-agent limit: 5 checks / user / guild / 10 min. */
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
      sub
        .setName('status')
        .setDescription('Show legacy operator claims and manual role-audit warning')
        .addIntegerOption((opt) =>
          opt.setName('page').setDescription('Legacy claims page (six per page)').setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Configure role display, registry checks, and log channel (Manage Guild)')
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
          opt.setName('sync_interval_minutes').setDescription('Legacy claim check interval in minutes'),
        )
        .addStringOption((opt) =>
          opt.setName('log_channel_id').setDescription('Channel ID for check warnings'),
        ),
    )
    .addSubcommand((sub) => sub
      .setName('control-start')
      .setDescription('Start a private wallet and bot-response witness (Manage Guild)')
      .addStringOption((opt) => opt.setName('url')
        .setDescription('HTTPS URL of the signed Discord attestation').setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('control-complete')
      .setDescription('Check a signed challenge and one exact bot message (Manage Guild)')
      .addStringOption((opt) => opt.setName('nonce').setDescription('Nonce from control-start').setRequired(true))
      .addStringOption((opt) => opt.setName('signature').setDescription('Wallet signature over exact challenge text').setRequired(true))
      .addStringOption((opt) => opt.setName('message_id').setDescription('Target bot message ID').setRequired(true)));

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
    .setDescription('Check a signed operator attestation; app control remains unproven')
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
  const pageRaw = ctx.getOption('page');
  const page = pageRaw === null ? 1 : Number(pageRaw);
  if (!Number.isSafeInteger(page) || page < 1) {
    return ephemeral('`page` must be a positive whole number.');
  }
  const config = deps.store.getGuildConfig(ctx.guildId);
  const bindings = deps.store.listBindings(ctx.guildId);
  const lines: string[] = [];

  if (!config?.roleId) {
    lines.push(
      `No Human-backed role is configured yet — an admin can run \`/fiador setup\`. (The role is named "${HUMAN_BACKED_ROLE_NAME}" by default and tracked by ID, so it can be renamed freely.)`,
    );
  } else {
    lines.push(`Human-backed role: <@&${statusField(config.roleId, 64)}> — admin must inspect all role holders in Discord; this bot does not have a complete member count.`);
  }
  lines.push(
    `Legacy claim check interval: ${config?.syncIntervalMinutes ?? deps.defaultSyncIntervalMinutes} minutes. Registry: ${statusField(config?.registryUrl ?? '(instance default)', 120)}.`,
  );
  lines.push(
    'ADMIN AUDIT REQUIRED: Stored claims do not prove Discord application control. Review existing Human-backed role holders manually and remove unsupported roles. Fiador grants and revokes no roles.',
  );

  if (bindings.length === 0) {
    lines.push('No legacy bindings are stored. `/attest` checks operator claims but cannot bind applications until control is proven.');
  } else {
    const totalPages = Math.ceil(bindings.length / STATUS_PAGE_SIZE);
    if (page > totalPages) {
      lines.push(`No legacy claims on page ${page}. Available pages: 1–${totalPages}.`);
      return ephemeral(lines.join('\n'));
    }
    lines.push(`Stored legacy operator claims: page ${page} of ${totalPages}. Use /fiador status page:<number> for another page.`);
    const first = (page - 1) * STATUS_PAGE_SIZE;
    for (const binding of bindings.slice(first, first + STATUS_PAGE_SIZE)) {
      const last = deps.store.getLatestCheck(ctx.guildId, binding.applicationId);
      const applicationId = statusField(binding.applicationId, 32);
      lines.push(
        last
          ? `• Application ${applicationId} — application control unproven; no role automation; last attestation check: **${statusField(last.status, 24)}** at ${statusField(last.checkedAt, 32)}`
          : `• Application ${applicationId} — application control unproven; no role automation; not checked yet`,
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
      'Bot-response witnessing is available through /fiador control-start. It is not app-control proof. Role automation is disabled.',
    ].join('\n'),
  );
}

export async function handleFiadorControlStart(
  ctx: CommandContext,
  deps: CommandDeps,
): Promise<ReplyPayload> {
  if (!ctx.hasManageGuild) return ephemeral('`/fiador control-start` requires Manage Guild.');
  if (!deps.appControl) return ephemeral('Challenge witness is unavailable on this verifier.');
  if (!deps.rateLimiter.tryAcquire(`control:${ctx.guildId}:${ctx.userId}`)) {
    return ephemeral('Too many challenge attempts — try again in a few minutes.');
  }
  const url = ctx.getOption('url');
  if (!url) return ephemeral('Provide the signed attestation `url`.');
  try {
    const challenge = await deps.appControl.start(ctx.guildId, ctx.channelId, url);
    return ephemeral([
      `Challenge nonce: \`${challenge.nonce}\`. Expires ${challenge.expiresAt}.`,
      'Sign the private text below with the attestation wallet. Do not post it. Have the named bot post only the separate public text in this channel, then run `/fiador control-complete` with the signature and bot message ID.',
      'This records a bot response only. It does not establish application-operator control or grant a role.',
      'Private wallet-signature text:',
      `\`\`\`text\n${canonicalChallengeText(challenge)}\n\`\`\``,
      'Public bot-response text:',
      `\`\`\`text\n${canonicalBotResponseText(challenge)}\n\`\`\``,
    ].join('\n'));
  } catch (error) {
    return ephemeral(`No challenge was started: ${error instanceof Error ? error.message : 'verification unavailable'}`);
  }
}

export async function handleFiadorControlComplete(
  ctx: CommandContext,
  deps: CommandDeps,
): Promise<ReplyPayload> {
  if (!ctx.hasManageGuild) return ephemeral('`/fiador control-complete` requires Manage Guild.');
  if (!deps.appControl) return ephemeral('Challenge witness is unavailable on this verifier.');
  if (!deps.rateLimiter.tryAcquire(`control:${ctx.guildId}:${ctx.userId}`)) {
    return ephemeral('Too many challenge attempts — try again in a few minutes.');
  }
  try {
    const witnessed = await deps.appControl.complete(
      ctx.guildId, ctx.getOption('nonce') ?? '', ctx.getOption('signature') ?? '',
      ctx.getOption('message_id') ?? '',
    );
    return ephemeral(witnessed
      ? 'Fresh signed-wallet and bot-response witness recorded. Application-operator control remains unproven; no binding or role was changed.'
      : 'No witness recorded. The challenge may be invalid, expired, used, or the wallet and Discord evidence may not match.');
  } catch {
    return ephemeral('No witness recorded because an external check was unavailable. Retry while the challenge is still live.');
  }
}

export async function handleVerifyAgent(
  ctx: CommandContext,
  deps: CommandDeps,
): Promise<ReplyPayload> {
  const applicationId = ctx.getOption('application_id');
  if (!applicationId) {
    return ephemeral('Provide an `application_id` to check.');
  }
  if (!deps.rateLimiter.tryAcquire(`${ctx.guildId}:${ctx.userId}`)) {
    return ephemeral('Too many checks — try again in a few minutes.');
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
    return ephemeral('Too many checks — try again in a few minutes.');
  }

  const url = ctx.getOption('url');
  const pasted = ctx.getOption('attestation');
  if (!url && !pasted) {
    return ephemeral('Provide either a `url` where the attestation is hosted, or paste the `attestation` JSON.');
  }

  let attestation: SignedAttestation;
  try {
    if (url) {
      attestation = await deps.service.fetchAttestation(url);
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

  // A valid operator signature proves the wallet made a claim about an
  // application. It does not prove the wallet controls that application.
  // Until there is a separate Discord-authenticated control challenge,
  // /attest must not bind the application or change its role.
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

  return {
    ephemeral: true,
    content: `The operator attestation for application ${applicationId} passed, but control of that Discord application is unproven. Nothing was bound and no Human-backed role was granted.`,
    embeds: [embed],
  };
}
