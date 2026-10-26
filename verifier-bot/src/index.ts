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
  ApplicationCommandOptionType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  type ChatInputCommandInteraction,
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
import { loadConfig } from './config.js';
import type { DiscordAdapter } from './discordAdapter.js';
import { scheduleGuildSync, startCheckLogPruning } from './maintenance.js';
import { RoleSyncEngine, warnLegacyRoleAudit } from './roles.js';
import { SqliteStore, type Store } from './store.js';
import { VerifyService, type VerifierLike } from './verifyService.js';

export class DiscordJsAdapter implements DiscordAdapter {
  constructor(
    private readonly client: Client,
    private readonly store: Store,
  ) {}

  async sendLogLine(guildId: string, line: string): Promise<void> {
    const logChannelId = this.store.getGuildConfig(guildId)?.logChannelId;
    if (!logChannelId) return;
    const channel = await this.client.channels.fetch(logChannelId).catch(() => null);
    if (channel && 'guildId' in channel && channel.guildId === guildId && channel.isTextBased()) {
      await (channel as TextChannel).send(line).catch(() => undefined);
    }
  }
}

export function toContext(interaction: ChatInputCommandInteraction): CommandContext {
  return {
    guildId: interaction.guildId ?? '',
    userId: interaction.user.id,
    hasManageGuild:
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
    getOption: (name) => {
      const option = interaction.options.get(name);
      if (option?.type === ApplicationCommandOptionType.String && typeof option.value === 'string') {
        return option.value;
      }
      if (option?.type === ApplicationCommandOptionType.Integer && typeof option.value === 'number') {
        return String(option.value);
      }
      return null;
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

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = loadConfig(env);
  const store = new SqliteStore(config.dbPath);
  startCheckLogPruning(store);
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
    // Login line: own user ID and guild count only — never the token.
    console.log(
      `fiador: logged in as ${ready.user.id}, serving ${ready.guilds.cache.size} guild(s).`,
    );
    // Re-check legacy bindings before the scheduler starts. This records
    // evidence and warnings, without changing guild roles.
    void (async () => {
      for (const guildId of store.listGuildIds()) {
        await warnLegacyRoleAudit(guildId, store, adapter);
        await engine.syncGuild(guildId).catch(() => undefined);
      }
      scheduleGuildSync(store, engine, config.syncIntervalMinutes);
    })();
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
