import { toPublicVerifyResult, type PublicVerifyResult, type SignedAttestation, type Verifier } from '@fiador/verify';
import {
  discordProfileFailure,
  discordProfileShapeFailure,
  isDiscordSnowflake,
} from '../../link-preview/src/profile.js';
import type { RegistryEntry } from '../../link-preview/src/registry.js';

export type ResultState = 'claim_unconfirmed' | 'expired' | 'unverified' | 'revoked' | 'not_found' | 'could_not_check';

export interface PageResult {
  state: ResultState;
  heading: string;
  verdict: string;
  checkedAt: string;
  applicationId?: string;
  applicationName?: string;
  botUserId?: string;
  addressTruncated?: string;
  humanHashTruncated?: string;
  expiresAt?: string;
  operatorName?: string;
  note?: string;
}

export interface CheckInput {
  attestation: unknown;
  verifier: Verifier;
  entry?: RegistryEntry;
  fetchedUrl?: string;
  registryChecked: boolean;
  signal?: AbortSignal;
}

function now(): string { return new Date().toISOString(); }

export function stateResult(state: Exclude<ResultState, 'claim_unconfirmed' | 'expired' | 'unverified'>, verdict: string): PageResult {
  const heading = {
    revoked: 'Revoked',
    not_found: 'Attestation not found',
    could_not_check: 'Could not check',
  }[state];
  return { state, heading, verdict, checkedAt: now() };
}

function truncateHash(hash: string | null): string | undefined {
  return hash ? `${hash.slice(0, 12)}…${hash.slice(-8)}` : undefined;
}

function failureSentence(result: PublicVerifyResult): string {
  const failures = result.failures;
  if (failures.includes('lookup_timeout') || failures.includes('lookup_failed')) {
    return 'The live AgentBook check could not complete. This is not a negative verdict.';
  }
  if (failures.includes('signature_mismatch')) return 'Not verified: the signature does not match the claimed wallet.';
  if (failures.includes('subject_mismatch')) return 'Not verified: the attestation names a different Discord application.';
  if (failures.includes('malformed_attestation') || failures.includes('unsupported_version')) return 'Not verified: the attestation is malformed.';
  if (failures.includes('not_yet_valid')) return 'Not verified: the attestation is not yet valid.';
  if (failures.includes('not_registered')) return 'Not verified: the signing wallet is not registered in AgentBook.';
  if (failures.includes('replay_detected')) return 'Not verified: this attestation has already been presented.';
  return 'Not verified: this attestation failed verification.';
}

function signedFields(input: unknown): SignedAttestation | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Partial<SignedAttestation>;
  if (!value.payload || typeof value.payload !== 'object' || !value.payload.subject) return null;
  return value as SignedAttestation;
}

/** Shared verify core and shared Discord profile checks used by /v/. */
export async function checkAttestation(input: CheckInput): Promise<PageResult> {
  const signed = signedFields(input.attestation);
  const candidateId = signed?.payload?.subject?.id;
  const expectedId = input.entry?.discord_application_id ?? candidateId;
  const expectedSubject = isDiscordSnowflake(expectedId)
    ? { type: 'discord_application', id: expectedId }
    : undefined;
  const internal = await input.verifier.verifyAttestation(input.attestation, {
    ...(expectedSubject ? { expectedSubject } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const result = toPublicVerifyResult(internal);
  const base: PageResult = {
    state: 'unverified',
    heading: 'Not verified',
    verdict: failureSentence(result),
    checkedAt: result.evidence.checkedAt,
    addressTruncated: result.addressTruncated,
    ...(signed && isDiscordSnowflake(candidateId) ? { applicationId: candidateId } : {}),
  };
  if (result.status === 'unknown') {
    return { ...base, state: 'could_not_check', heading: 'Could not check' };
  }
  if (result.status !== 'verified' && result.status !== 'expired') return base;
  if (!signed || !isDiscordSnowflake(expectedId)) {
    return { ...base, verdict: 'Not verified: the Discord application ID is missing or invalid.' };
  }
  const entry: RegistryEntry = input.entry ?? {
    discord_application_id: expectedId,
    attestation_url: input.fetchedUrl ?? signed.payload.attestationUrl ?? '',
  };
  const profileFailure = result.status === 'verified'
    ? discordProfileFailure(signed, entry, result.humanHash)
    : discordProfileShapeFailure(signed, entry);
  if (profileFailure) return { ...base, verdict: profileFailure };
  const name = signed.payload.extra?.discord_application_name ?? input.entry?.name;
  const fields: Partial<PageResult> = {
    applicationId: expectedId,
    applicationName: typeof name === 'string' && name.trim() ? name : expectedId,
    botUserId: signed.payload.extra?.discord_bot_user_id,
    addressTruncated: result.addressTruncated,
    expiresAt: signed.payload.expiresAt,
    ...(result.status === 'verified' && result.humanHash ? { humanHashTruncated: truncateHash(result.humanHash) } : {}),
    ...(typeof signed.payload.operatorDisplayName === 'string' && signed.payload.operatorDisplayName.trim()
      ? { operatorName: signed.payload.operatorDisplayName }
      : {}),
  };
  if (result.status === 'expired') {
    return { ...base, ...fields, state: 'expired', heading: 'Expired', verdict: 'This attestation has expired and no longer verifies.' };
  }
  return {
    ...base,
    ...fields,
    state: 'claim_unconfirmed',
    heading: 'Claim unconfirmed',
    verdict: 'Wallet signature, signed Discord profile, and live AgentBook registration passed. Control of the named Discord application is not established.',
    ...(!input.registryChecked ? { note: 'No registry entry was confirmed. This result cannot rule out revocation or an unlisted claim.' } : {}),
  };
}
