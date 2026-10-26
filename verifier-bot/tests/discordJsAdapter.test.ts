import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import { DiscordJsAdapter } from '../src/index.js';
import { InMemoryStore } from '../src/store.js';

function configuredAdapter(channel: unknown) {
  const fetch = vi.fn().mockResolvedValue(channel);
  const client = { channels: { fetch } } as unknown as Client;
  const store = new InMemoryStore();
  store.upsertGuildConfig({
    guildId: 'source-guild',
    roleId: null,
    registryUrl: null,
    syncIntervalMinutes: 360,
    logChannelId: 'configured-channel',
  });
  return { adapter: new DiscordJsAdapter(client, store), fetch };
}

describe('DiscordJsAdapter audit channel', () => {
  it('posts only to a text channel owned by the originating guild', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { adapter, fetch } = configuredAdapter({
      guildId: 'source-guild',
      isTextBased: () => true,
      send,
    });

    await adapter.sendLogLine('source-guild', 'warning');

    expect(fetch).toHaveBeenCalledWith('configured-channel');
    expect(send).toHaveBeenCalledExactlyOnceWith('warning');
  });

  it.each([
    ['another guild', { guildId: 'other-guild', isTextBased: () => true }],
    ['a direct message', { isTextBased: () => true }],
    ['a non-text channel', { guildId: 'source-guild', isTextBased: () => false }],
  ])('does not post to %s', async (_label, channel) => {
    const send = vi.fn();
    const { adapter } = configuredAdapter({ ...channel, send });

    await adapter.sendLogLine('source-guild', 'warning');

    expect(send).not.toHaveBeenCalled();
  });

  it('does not post when the configured channel cannot be found', async () => {
    const { adapter, fetch } = configuredAdapter(null);

    await expect(adapter.sendLogLine('source-guild', 'warning')).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith('configured-channel');
  });
});
