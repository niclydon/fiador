// Keep these Discord profile rules in parity with link-preview/src/profile.ts.
// The bot checks them before recording even a limited bot-response witness.
import type { SignedAttestation } from '@fiador/verify';

const SNOWFLAKE = /^[0-9]{17,20}$/;
const HUMAN_HASH = /^[0-9a-f]{64}$/;
const EXTRA_FIELDS = new Set(['discord_application_name', 'discord_bot_user_id', 'human_id_hash']);

export function isDiscordSnowflake(value: unknown): value is string {
  return typeof value === 'string' && SNOWFLAKE.test(value);
}

export function discordProfileFailure(
  attestation: SignedAttestation,
  applicationId: string,
  attestationUrl: string,
  liveHumanHash: string | null,
): string | null {
  const { payload } = attestation;
  if (
    payload.subject.type !== 'discord_application' ||
    !isDiscordSnowflake(payload.subject.id) ||
    payload.subject.id !== applicationId
  ) return 'The signed Discord application ID is missing or invalid.';
  if (payload.humanIdDisclosure !== 'hash') return 'The Discord profile requires hash disclosure.';
  if (payload.attestationUrl !== attestationUrl) return 'The signed attestation URL does not match the fetched URL.';
  const extra = payload.extra;
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return 'The human hash is missing or malformed.';
  const unknownFields = Object.keys(extra).filter((field) => !EXTRA_FIELDS.has(field));
  if (unknownFields.some((field) => /human.?id/i.test(field))) return 'Raw human ID fields are not allowed.';
  if (unknownFields.length > 0) return 'This Discord profile contains unsupported signed fields.';
  if (typeof extra.human_id_hash !== 'string' || !HUMAN_HASH.test(extra.human_id_hash)) {
    return 'The human hash is missing or malformed.';
  }
  if (!isDiscordSnowflake(extra.discord_bot_user_id)) return 'The Discord bot user ID is missing or invalid.';
  if (extra.discord_application_name !== undefined && typeof extra.discord_application_name !== 'string') {
    return 'The Discord application name is malformed.';
  }
  if (payload.operatorDisplayName !== undefined &&
      (typeof payload.operatorDisplayName !== 'string' || payload.operatorDisplayName.length > 64)) {
    return 'The operator display name is malformed.';
  }
  if (extra.human_id_hash !== liveHumanHash) return 'The signed human hash does not match live AgentBook.';
  return null;
}
