// Shared test doubles: a fake Discord adapter and a command-context factory.
// No network, no token, no real Discord anywhere in the suite.

import type { DiscordAdapter } from '../src/discordAdapter.js';
import type { CommandContext } from '../src/commands.js';

export class FakeDiscordAdapter implements DiscordAdapter {
  /** Set of `${guildId}:${userId}` currently holding the role. */
  readonly roleHolders = new Set<string>();
  readonly grants: { guildId: string; userId: string; roleId: string; reason: string }[] = [];
  readonly revokes: { guildId: string; userId: string; roleId: string; reason: string }[] = [];
  readonly logLines: { guildId: string; line: string }[] = [];
  ownBotId = '555555555555555555';
  integrations: unknown = [];
  channelGuildId: string | null = 'guild-1';
  message: unknown = null;

  verifierBotUserId(): string | null { return this.ownBotId; }
  async getGuildIntegrations(): Promise<unknown> { return this.integrations; }
  async getChannelGuildId(): Promise<string | null> { return this.channelGuildId; }
  async getChannelMessage(): Promise<unknown> { return this.message; }

  private static key(guildId: string, userId: string): string {
    return `${guildId}:${userId}`;
  }

  async memberHasRole(guildId: string, userId: string): Promise<boolean> {
    return this.roleHolders.has(FakeDiscordAdapter.key(guildId, userId));
  }

  async grantRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void> {
    this.grants.push({ guildId, userId, roleId, reason });
    this.roleHolders.add(FakeDiscordAdapter.key(guildId, userId));
  }

  async revokeRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void> {
    this.revokes.push({ guildId, userId, roleId, reason });
    this.roleHolders.delete(FakeDiscordAdapter.key(guildId, userId));
  }

  async sendLogLine(guildId: string, line: string): Promise<void> {
    this.logLines.push({ guildId, line });
  }

  giveRole(guildId: string, userId: string): void {
    this.roleHolders.add(FakeDiscordAdapter.key(guildId, userId));
  }
}

export function makeCtx(
  options: Record<string, string> = {},
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    guildId: 'guild-1',
    channelId: 'channel-1',
    userId: 'user-1',
    hasManageGuild: true,
    getOption: (name) => options[name] ?? null,
    ...overrides,
  };
}
