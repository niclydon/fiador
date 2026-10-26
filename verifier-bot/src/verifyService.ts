// Verify service: the bot's one path from "an application ID (or a
// presented attestation)" to a checked, logged, public-shaped result.
//
// It wraps the verify core (@fiador/verify, W0 spec §3) and supplies the
// consumer-side pieces the core deliberately does not own: finding the
// attestation (guild binding first, then the registry), fetching it
// through the SSRF guard, and writing every check to check_log.
//
// Everything this service returns for display has passed through
// toPublicVerifyResult: no full humanId, no full wallet address in the
// result object. The internal VerifyResult is used only to fill the
// check_log row on the self-hoster's own machine.

import { createHash } from 'node:crypto';
import {
  canonicalAttestationMessage,
  toPublicVerifyResult,
  type PublicVerifyResult,
  type SignedAttestation,
  type VerifyResult,
} from '@fiador/verify';
import { guardedFetchJson } from './fetchGuard.js';
import type { Store } from './store.js';

/** Structural shape of the verify core (DESIGN §4.1 / W0 spec §3). */
export interface VerifyAttestationOptions {
  expectedSubject?: { type: string; id: string };
  expectedWallet?: `0x${string}`;
  checkRegistration?: boolean;
}

export type StatusSubject =
  | { kind: 'address'; address: string }
  | { kind: 'attestation'; attestation: SignedAttestation }
  | {
      kind: 'attested_subject';
      subject: { type: string; id: string };
      resolveAttestation: (subject: { type: string; id: string }) => Promise<SignedAttestation | null>;
    };

export interface VerifierLike {
  verifyAddress(address: string, opts?: { signal?: AbortSignal }): Promise<VerifyResult>;
  verifyAttestation(
    attestation: unknown,
    opts?: VerifyAttestationOptions,
  ): Promise<VerifyResult>;
  resolveStatus(subject: StatusSubject, opts?: { signal?: AbortSignal }): Promise<VerifyResult>;
}

export interface RegistryEntry {
  discord_application_id: string;
  attestation_url: string;
  status?: string;
  submitted_by?: string;
  added_at?: string;
}

export interface CheckOutcome {
  applicationId: string;
  /** Public shape only — the only result form commands/embeds may render. */
  result: PublicVerifyResult;
  /** The attestation that was checked, when one was presented or found. */
  attestation: SignedAttestation | null;
  /** Bot user ID from the payload's signed extra field, when present. */
  botUserId: string | null;
}

export interface VerifyServiceDeps {
  verifier: VerifierLike;
  store: Store;
  /** Injectable for tests; defaults to the SSRF-guarded fetcher. */
  fetchJson?: (url: string) => Promise<unknown>;
  defaultRegistryUrl?: string | null;
}

export function isSignedAttestation(value: unknown): value is SignedAttestation {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.payload === 'object' &&
    v.payload !== null &&
    typeof v.signature === 'string' &&
    (v.signatureType === 'eip191' || v.signatureType === 'eip1271')
  );
}

export function payloadHash(attestation: SignedAttestation): string {
  return createHash('sha256')
    .update(canonicalAttestationMessage(attestation.payload), 'utf8')
    .digest('hex');
}

export class VerifyService {
  private readonly verifier: VerifierLike;
  private readonly store: Store;
  private readonly fetchJson: (url: string) => Promise<unknown>;
  private readonly defaultRegistryUrl: string | null;

  constructor(deps: VerifyServiceDeps) {
    this.verifier = deps.verifier;
    this.store = deps.store;
    this.fetchJson = deps.fetchJson ?? ((url) => guardedFetchJson(url));
    this.defaultRegistryUrl = deps.defaultRegistryUrl ?? null;
  }

  /** Fetch an attestation document through the guard and shape-check it. */
  async fetchAttestation(url: string): Promise<SignedAttestation> {
    const doc = await this.fetchJson(url);
    if (!isSignedAttestation(doc)) {
      throw new Error(`Document at ${url} is not a signed Fiador attestation.`);
    }
    return doc;
  }

  /** Look up one application in a registry document (DESIGN §3.4 format). */
  async fetchRegistryEntry(
    registryUrl: string,
    applicationId: string,
  ): Promise<RegistryEntry | null> {
    const doc = (await this.fetchJson(registryUrl)) as { entries?: RegistryEntry[] } | null;
    if (!doc || !Array.isArray(doc.entries)) return null;
    return doc.entries.find((e) => e.discord_application_id === applicationId) ?? null;
  }

  /**
   * Discovery (DESIGN §3.5): guild binding first, then the guild's
   * registry (falling back to the instance default registry).
   * Returns null when no attestation is published for the application.
   */
  async resolveAttestation(
    guildId: string,
    applicationId: string,
  ): Promise<SignedAttestation | null> {
    const binding = this.store.getBinding(guildId, applicationId);
    if (binding) {
      return this.fetchAttestation(binding.attestationUrl);
    }
    const registryUrl =
      this.store.getGuildConfig(guildId)?.registryUrl ?? this.defaultRegistryUrl;
    if (!registryUrl) return null;
    const entry = await this.fetchRegistryEntry(registryUrl, applicationId);
    if (!entry || entry.status === 'revoked') return null;
    return this.fetchAttestation(entry.attestation_url);
  }

  /** One-off check of an application ID. No state change beyond check_log. */
  async checkApplication(guildId: string, applicationId: string): Promise<CheckOutcome> {
    let presented: SignedAttestation | null = null;
    const result = await this.verifier.resolveStatus({
      kind: 'attested_subject',
      subject: { type: 'discord_application', id: applicationId },
      resolveAttestation: async () => {
        presented = await this.resolveAttestation(guildId, applicationId);
        return presented;
      },
    });
    return this.record(guildId, applicationId, result, presented);
  }

  /** Verify a presented attestation (the /attest flow). Logs the check. */
  async checkAttestation(
    guildId: string,
    attestation: SignedAttestation,
  ): Promise<CheckOutcome> {
    const applicationId = attestation.payload.subject.id;
    const result = await this.verifier.verifyAttestation(attestation, {
      expectedSubject: { type: 'discord_application', id: applicationId },
    });
    return this.record(guildId, applicationId, result, attestation);
  }

  private record(
    guildId: string,
    applicationId: string,
    internal: VerifyResult,
    attestation: SignedAttestation | null,
  ): CheckOutcome {
    const pub = toPublicVerifyResult(internal);
    this.store.appendCheckLog({
      guildId,
      applicationId,
      checkedAt: internal.evidence.checkedAt,
      status: pub.status,
      failures: pub.failures,
      wallet: internal.address ?? null,
      humanHash: pub.humanHash,
      expiresAt: attestation?.payload.expiresAt ?? null,
    });
    return {
      applicationId,
      result: pub,
      attestation,
      botUserId: attestation?.payload.extra?.discord_bot_user_id ?? null,
    };
  }
}
