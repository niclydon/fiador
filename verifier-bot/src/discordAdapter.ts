// The Discord adapter seam.
//
// Active Discord side effects (log-channel posts) go
// through this interface. commands.ts and roles.ts depend only
// on the interface; index.ts supplies the real discord.js implementation
// and tests supply fakes. Nothing outside index.ts imports discord.js
// values, which is what keeps the whole bot testable without a token.

export interface DiscordAdapter {
  /** Post one compact line to the guild's configured log channel, if any. */
  sendLogLine(guildId: string, line: string): Promise<void>;
}
