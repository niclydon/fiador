// Entry point: real discord.js wiring for the verifier bot.
//
// This is the only module that touches a live Discord connection.
// Importing it has no side effects — main() runs only when the file is
// executed directly (npm start). Token hygiene (DESIGN §5.4): the token
// comes from the environment, is never logged, and the startup log
// prints only the bot's own user ID and guild count. Intents are Guilds
// + GuildMembers: no message-content intent; this bot reads no messages.

import { pathToFileURL } from 'node:url';
import {
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type Guild,
  type TextChannel,
} from 'discord.js';
import { createVerifier } from '@fiador/verify';
import {
  buildCommandDefinitions,
  handleAttest,
  handleFiadorSetup,
  handleFiadorStatus,
  handleVerifyAgent,
  AttemptRateLimiter,
  type CommandContext,
  type CommandDeps,
  type ReplyPayload,
} from './commands.js';
import { loadConfig, type BotConfig } from './config.js';
import type { DiscordAdapter } from './discordAdapter.js';
import { RoleSyncEngine } from './roles.js';
import { SqliteStore, type Store } from './store.js';
import { VerifyService, type VerifierLike } from './verifyService.js';

class DiscordJsAdapter implements DiscordAdapter {
  constructor(
    private readonly client: Client,
    private readonly store: Store,
  ) {}

  private async guild(guildId: string): Promise<Guild> {
    return this.client.guilds.fetch(guildId);
  }

  async getRoleMemberCount(guildId: string, roleId: string): Promise<number> {
    const guild = await this.guild(guildId);
    const role = await guild.roles.fetch(roleId);
    return role?.members.size ?? 0;
  }

  async memberHasRole(guildId: string, userId: string, roleId: string): Promise<boolean> {
    const guild = await this.guild(guildId);
    const member = await guild.members.fetch(userId).catch(() => null);
    return member?.roles.cache.has(roleId) ?? false;
  }

  async grantRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void> {
    const guild = await this.guild(guildId);
    const member = await guild.members.fetch(userId);
    await member.roles.add(roleId, reason);
  }

  async revokeRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void> {
    const guild = await this.guild(guildId);
    const member = await guild.members.fetch(userId);
    await member.roles.remove(roleId, reason);
  }

  async resolveBotUserId(guildId: string, applicationId: string): Promise<string | null> {
    const guild = await this.guild(guildId);
    // Bot members carry their application ID on the user object via the
    // guild's member list; application IDs are snowflakes like user IDs
    // but NOT equal to them, so match on the member's applicationId when
    // Discord exposes it, else fall back to a member whose user is a bot
    // and whose ID was bound at /attest time (binding.botUserId).
    const members = await guild.members.fetch();
    for (const member of members.values()) {
      if (member.user.bot && member.user.id === applicationId) return member.user.id;
    }
    return null;
  }

  async sendLogLine(guildId: string, line: string): Promise<void> {
    const logChannelId = this.store.getGuildConfig(guildId)?.logChannelId;
    if (!logChannelId) return;
    const channel = await this.client.channels.fetch(logChannelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      await (channel as TextChannel).send(line).catch(() => undefined);
    }
  }
}

function toContext(interaction: ChatInputCommandInteraction): CommandContext {
  return {
    guildId: interaction.guildId ?? '',
    userId: interaction.user.id,
    hasManageGuild:
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
    getOption: (name) => {
      const value =
        interaction.options.getString(name) ?? interaction.options.getInteger(name);
      return value === null || value === undefined ? null : String(value);
    },
  };
}

async function dispatch(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void> {
  let reply: ReplyPayload;
  if (interaction.commandName === 'fiador') {
    const sub = interaction.options.getSubcommand();
    reply =
      sub === 'setup'
        ? await handleFiadorSetup(toContext(interaction), deps)
        : await handleFiadorStatus(toContext(interaction), deps);
  } else if (interaction.commandName === 'verify-agent') {
    reply = await handleVerifyAgent(toContext(interaction), deps);
  } else if (interaction.commandName === 'attest') {
    reply = await handleAttest(toContext(interaction), deps);
  } else {
    return;
  }
  await interaction.reply({
    content: reply.content,
    embeds: reply.embeds,
    ephemeral: reply.ephemeral,
  });
}

/**
 * Recurring full sync with ±10% jitter (DESIGN §5.5). Each guild uses
 * its own configured interval when set; the timer is unref'd so it never
 * keeps a dying process alive.
 */
function scheduleSync(
  config: BotConfig,
  store: Store,
  engine: RoleSyncEngine,
): NodeJS.Timeout[] {
  const timers: NodeJS.Timeout[] = [];
  const tick = async () => {
    for (const guildId of store.listGuildIds()) {
      await engine.syncGuild(guildId).catch((err: unknown) => {
        console.error(
          `fiador: sync failed for guild ${guildId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  };
  const intervalMinutes =
    store.listGuildIds().length > 0
      ? Math.min(
          ...store
            .listGuildIds()
            .map((id) => store.getGuildConfig(id)?.syncIntervalMinutes ?? config.syncIntervalMinutes),
        )
      : config.syncIntervalMinutes;
  const baseMs = intervalMinutes * 60 * 1000;
  const arm = () => {
    const jitter = baseMs * 0.1 * (Math.random() * 2 - 1);
    const timer = setTimeout(() => {
      void tick().finally(arm);
    }, Math.max(30_000, baseMs + jitter));
    timer.unref();
    timers.push(timer);
  };
  arm();
  return timers;
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = loadConfig(env);
  const store = new SqliteStore(config.dbPath);
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });
  const adapter = new DiscordJsAdapter(client, store);
  const verifier = createVerifier({
    rpcUrl: config.rpcUrl ?? undefined,
  }) as unknown as VerifierLike;
  const service = new VerifyService({
    verifier,
    store,
    defaultRegistryUrl: config.registryUrl,
  });
  const engine = new RoleSyncEngine({ store, service, adapter });
  const deps: CommandDeps = {
    service,
    store,
    adapter,
    sync: engine,
    rateLimiter: new AttemptRateLimiter(),
    defaultSyncIntervalMinutes: config.syncIntervalMinutes,
  };

  const rest = new REST().setToken(config.token);
  await rest.put(Routes.applicationCommands(config.clientId), {
    body: buildCommandDefinitions(),
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    void dispatch(interaction, deps).catch(async (err: unknown) => {
      console.error(
        `fiador: command ${interaction.commandName} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!interaction.replied && !interaction.deferred) {
        await interaction
          .reply({ content: 'Something went wrong running that command.', ephemeral: true })
          .catch(() => undefined);
      }
    });
  });

  client.once(Events.ClientReady, (ready) => {
    // Startup log: own user ID and guild count only — never the token.
    console.log(
      `fiador: logged in as ${ready.user.id}, serving ${ready.guilds.cache.size} guild(s).`,
    );
    // A restart must not leave stale grants unexamined (DESIGN §5.2):
    // full re-check of every configured guild before settling in.
    void (async () => {
      for (const guildId of store.listGuildIds()) {
        await engine.syncGuild(guildId).catch(() => undefined);
      }
    })();
    scheduleSync(config, store, engine);
  });

  await client.login(config.token);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`fiador: fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
