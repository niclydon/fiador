// The Discord adapter seam.
//
// All Discord side effects (role reads/writes, member lookups, log-channel
// posts) go through this interface. commands.ts and roles.ts depend only
// on the interface; index.ts supplies the real discord.js implementation
// and tests supply fakes. Nothing outside index.ts imports discord.js
// values, which is what keeps the whole bot testable without a token.

export interface DiscordAdapter {
  /** Number of members currently holding the guild's Human-backed role. */
  getRoleMemberCount(guildId: string, roleId: string): Promise<number>;
  /** Whether the given user currently holds the role in the guild. */
  memberHasRole(guildId: string, userId: string, roleId: string): Promise<boolean>;
  /** Add the role to the user. `reason` lands in the guild audit log. */
  grantRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void>;
  /** Remove the role from the user. `reason` lands in the guild audit log. */
  revokeRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void>;
  /**
   * Resolve which bot user an application ID corresponds to in this guild
   * (needed to grant that bot the role). Null when it cannot be resolved —
   * e.g. the bot is not a member of the guild.
   */
  resolveBotUserId(guildId: string, applicationId: string): Promise<string | null>;
  /** Post one compact line to the guild's configured log channel, if any. */
  sendLogLine(guildId: string, line: string): Promise<void>;
}
