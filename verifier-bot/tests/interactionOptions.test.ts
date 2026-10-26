import { describe, expect, it } from 'vitest';
import {
  ApplicationCommandOptionType,
  CommandInteractionOptionResolver,
  PermissionFlagsBits,
  PermissionsBitField,
  type ChatInputCommandInteraction,
  type CommandInteractionOption,
} from 'discord.js';
import { handleFiadorSetup, handleFiadorStatus, type CommandDeps } from '../src/commands.js';
import { toContext } from '../src/index.js';
import { InMemoryStore } from '../src/store.js';
import { FakeDiscordAdapter } from './helpers.js';

function interactionFor(
  subcommand: 'status' | 'setup',
  options: CommandInteractionOption[],
): ChatInputCommandInteraction {
  // discord.js keeps this constructor private in its types, but creates
  // the same resolver from interaction payloads at runtime.
  const resolver = Reflect.construct(CommandInteractionOptionResolver, [
    {},
    [{ type: ApplicationCommandOptionType.Subcommand, name: subcommand, options }],
    {},
  ]) as CommandInteractionOptionResolver;
  return {
    guildId: 'guild-1',
    user: { id: 'user-1' },
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    options: resolver,
  } as unknown as ChatInputCommandInteraction;
}

function commandDeps(): { deps: CommandDeps; store: InMemoryStore } {
  const store = new InMemoryStore();
  const deps = {
    store,
    adapter: new FakeDiscordAdapter(),
    defaultSyncIntervalMinutes: 360,
  } as unknown as CommandDeps;
  return { deps, store };
}

describe('discord.js interaction option adaptation', () => {
  it('reads the integer status page from the real resolver and renders page two', async () => {
    const interaction = interactionFor('status', [
      { type: ApplicationCommandOptionType.Integer, name: 'page', value: 2 },
    ]);
    const context = toContext(interaction);
    expect(context.getOption('page')).toBe('2');
    expect(context.getOption('missing')).toBeNull();

    const { deps, store } = commandDeps();
    for (let i = 0; i < 7; i++) {
      store.upsertBinding({
        guildId: 'guild-1',
        applicationId: String(123456789012345678n + BigInt(i)),
        attestationUrl: 'https://operator.example.com/attestation.json',
        payloadHash: null,
        boundVia: 'url',
        boundBy: 'user-1',
        boundAt: '2026-10-25T00:00:00.000Z',
        botUserId: null,
      });
    }
    const reply = await handleFiadorStatus(context, deps);
    expect(reply.content).toContain('page 2 of 2');
    expect(reply.content?.match(/• Application /g)).toHaveLength(1);
  });

  it('reads setup integer and string options without a type mismatch', async () => {
    const interaction = interactionFor('setup', [
      { type: ApplicationCommandOptionType.Integer, name: 'sync_interval_minutes', value: 75 },
      { type: ApplicationCommandOptionType.String, name: 'registry_url', value: 'https://example.com/registry.json' },
    ]);
    const context = toContext(interaction);
    expect(context.getOption('sync_interval_minutes')).toBe('75');
    expect(context.getOption('registry_url')).toBe('https://example.com/registry.json');

    const { deps, store } = commandDeps();
    const reply = await handleFiadorSetup(context, deps);
    expect(reply.content).toContain('Sync interval: 75 minutes');
    expect(store.getGuildConfig('guild-1')?.syncIntervalMinutes).toBe(75);
  });
});
