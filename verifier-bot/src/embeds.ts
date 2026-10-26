// Result presentation (DESIGN §5.3).
//
// Embeds are plain objects (the discord.js EmbedBuilder JSON shape), built
// from PublicVerifyResult ONLY — plus public payload fields the operator
// published inside the signed attestation itself (application ID, expiry,
// the opt-in operator display name). The internal VerifyResult, with its
// full address and any raw humanId, never reaches this module: there is
// nothing here to leak because the leakable fields are not inputs.
//
// Colours are the Nova Glass badge-state tokens: verified eye gold,
// expired amber, unverified grey, unknown cerulean.

import type {
  FailureCode,
  PublicVerifyResult,
  SignedAttestation,
  VerificationStatus,
} from '@fiador/verify';

export const DESCRIPTOR_LINE = 'Fiador — human-backed attestation for Discord bots';

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface EmbedObject {
  title: string;
  description?: string;
  color: number;
  fields: EmbedField[];
  footer: { text: string };
  timestamp?: string;
}

const STATUS_COLORS: Record<VerificationStatus, number> = {
  verified: 0xd4a55d, // eye gold
  expired: 0xc9933a, // amber
  invalid: 0x6e6e73, // grey
  unregistered: 0x6e6e73, // grey
  unknown: 0x4a7fa5, // cerulean
};

const STATUS_TITLES: Record<VerificationStatus, string> = {
  verified: 'Verified — human-backed',
  expired: 'Attestation expired',
  invalid: 'Attestation invalid',
  unregistered: 'Not registered in AgentBook',
  unknown: 'Could not complete the check',
};

/** One human sentence per failure code, shown verbatim in results. */
export const FAILURE_SENTENCES: Record<FailureCode, string> = {
  malformed_address: 'The wallet address in this attestation is malformed.',
  malformed_attestation: 'This attestation is malformed and cannot be verified.',
  unsupported_version: 'This attestation uses an unsupported format version.',
  signature_mismatch: 'The signature does not match the wallet in this attestation.',
  subject_mismatch: 'This attestation was issued for a different application.',
  wallet_mismatch: 'The attestation wallet does not match the expected wallet.',
  not_yet_valid: 'This attestation is not valid yet.',
  expired: 'This attestation has expired and must be renewed by its operator.',
  not_registered: 'The signing wallet has no AgentBook registration.',
  replay_detected: 'This attestation nonce has been seen before (possible replay).',
  attestation_not_found: 'No attestation was found for this application.',
  lookup_failed: 'The AgentBook lookup failed, so no conclusion was reached.',
  lookup_timeout: 'The AgentBook lookup timed out, so no conclusion was reached.',
};

export function failureSentence(code: FailureCode): string {
  return FAILURE_SENTENCES[code];
}

function truncateHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 10)}…` : hash;
}

export interface ResultEmbedInput {
  applicationId: string;
  botName?: string;
  result: PublicVerifyResult;
  attestation?: SignedAttestation | null;
}

export function buildResultEmbed(input: ResultEmbedInput): EmbedObject {
  const { result } = input;
  const payload = input.attestation?.payload;
  const fields: EmbedField[] = [
    { name: 'Application ID', value: input.applicationId, inline: true },
    { name: 'Status', value: result.status, inline: true },
    { name: 'Wallet', value: result.addressTruncated, inline: true },
  ];
  if (result.humanHash !== null) {
    fields.push({ name: 'Human hash', value: truncateHash(result.humanHash), inline: true });
  }
  const expiresAt = payload?.expiresAt;
  if (expiresAt) {
    fields.push({ name: 'Expires', value: expiresAt, inline: true });
  }
  fields.push({ name: 'Checked', value: result.evidence.checkedAt, inline: true });
  // The operator line exists ONLY when the payload carries the opt-in
  // self-asserted name (DESIGN §3.1.1); when absent, no line at all.
  if (payload?.operatorDisplayName) {
    fields.push({
      name: 'Operator (self-asserted)',
      value: payload.operatorDisplayName,
      inline: false,
    });
  }

  const description =
    result.status === 'verified'
      ? 'A unique human backs this bot: its operator attestation verified against AgentBook just now.'
      : result.failures.map(failureSentence).join(' ');

  return {
    title: `${input.botName ?? 'Bot'} — ${STATUS_TITLES[result.status]}`,
    description,
    color: STATUS_COLORS[result.status],
    fields,
    footer: { text: DESCRIPTOR_LINE },
    timestamp: result.evidence.checkedAt,
  };
}
