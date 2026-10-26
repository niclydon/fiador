// Discord-specific checks that the generic verify core cannot make.
// A passing profile still does not establish that the signing wallet
// controls the named Discord application.

import type { SignedAttestation } from '@fiador/verify';
import type { RegistryEntry } from './registry.js';

const SNOWFLAKE = /^[0-9]{17,20}$/;
const HUMAN_HASH = /^[0-9a-f]{64}$/;
const EXTRA_FIELDS = new Set([
  'discord_application_name',
  'discord_bot_user_id',
  'human_id_hash',
]);

export function isDiscordSnowflake(value: unknown): value is string {
  return typeof value === 'string' && SNOWFLAKE.test(value);
}

/** Checks available even when an expired attestation has no live human hash. */
export function discordProfileShapeFailure(
  attestation: SignedAttestation,
  entry: RegistryEntry,
): string | null {
  const { payload } = attestation;
  if (
    payload.subject.type !== 'discord_application' ||
    !isDiscordSnowflake(payload.subject.id) ||
    payload.subject.id !== entry.discord_application_id
  ) {
    return 'Not verified: the Discord application ID is missing or invalid.';
  }
  if (payload.humanIdDisclosure !== 'hash') {
    return 'Not verified: this public Discord profile requires hash disclosure.';
  }
  if (payload.attestationUrl !== entry.attestation_url) {
    return 'Not verified: the signed attestation URL does not match the fetched URL.';
  }
  const extra = payload.extra;
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
    return 'Not verified: the human hash is missing or malformed.';
  }
  const unknownFields = Object.keys(extra).filter((field) => !EXTRA_FIELDS.has(field));
  if (unknownFields.length > 0) {
    if (unknownFields.some((field) => /human.?id/i.test(field))) {
      return 'Not verified: raw human ID fields are not allowed.';
    }
    return 'Not verified: this Discord profile contains unsupported signed fields.';
  }
  if (typeof extra.human_id_hash !== 'string' || !HUMAN_HASH.test(extra.human_id_hash)) {
    return 'Not verified: the human hash is missing or malformed.';
  }
  if (!isDiscordSnowflake(extra.discord_bot_user_id)) {
    return 'Not verified: the Discord bot user ID is missing or invalid.';
  }
  if (
    extra.discord_application_name !== undefined &&
    typeof extra.discord_application_name !== 'string'
  ) {
    return 'Not verified: the Discord application name is malformed.';
  }
  if (
    payload.operatorDisplayName !== undefined &&
    (typeof payload.operatorDisplayName !== 'string' || payload.operatorDisplayName.length > 64)
  ) {
    return 'Not verified: the operator display name is malformed.';
  }
  return null;
}

/** Return a public-safe failure sentence, or null when the live profile passes. */
export function discordProfileFailure(
  attestation: SignedAttestation,
  entry: RegistryEntry,
  liveHumanHash: string | null,
): string | null {
  const shapeFailure = discordProfileShapeFailure(attestation, entry);
  if (shapeFailure) return shapeFailure;
  if (attestation.payload.extra?.human_id_hash !== liveHumanHash) {
    return 'Not verified: the signed human hash does not match the live AgentBook result.';
  }
  return null;
}
