// Verify service: the bot's one path from "an application ID (or a
// presented attestation)" to a checked, logged, public-shaped result.
//
// It wraps the verify core (@fiador/verify, W0 spec §3) and supplies the
// consumer-side pieces the core deliberately does not own: finding the
// attestation (registry revocation first, then an untrusted legacy URL), fetching it
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
  payload_hash?: string;
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
  /** No trusted proof yet links the signer to the Discord application. */
  applicationControl: 'unproven';
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
    const matches = doc.entries.filter((e) => e?.discord_application_id === applicationId);
    if (matches.length > 1) throw new Error('Duplicate registry application entries.');
    const entry = matches[0] ?? null;
    if (entry && (typeof entry.attestation_url !== 'string' ||
        (entry.payload_hash !== undefined && !/^[0-9a-f]{64}$/.test(entry.payload_hash)) ||
        (entry.status !== undefined && entry.status !== 'revoked'))) {
      throw new Error('Malformed registry entry.');
    }
    return entry;
  }

  /** A configured registry cannot be bypassed by a different local URL or payload. */
  async isPublishedClaimCurrent(
    guildId: string, applicationId: string, attestationUrl: string, canonicalPayloadHash: string,
  ): Promise<boolean> {
    const registryUrl = this.store.getGuildConfig(guildId)?.registryUrl ?? this.defaultRegistryUrl;
    if (!registryUrl) return true;
    const entry = await this.fetchRegistryEntry(registryUrl, applicationId);
    if (!entry) return true;
    return entry.status !== 'revoked' && entry.attestation_url === attestationUrl &&
      (entry.payload_hash === undefined || entry.payload_hash === canonicalPayloadHash);
  }

  /**
   * Discovery: a registry tombstone always blocks a legacy binding.
   * Active registry entries precede legacy local URLs; neither proves app control.
   * Returns null when no attestation is published for the application.
   */
  async resolveAttestation(
    guildId: string,
    applicationId: string,
  ): Promise<SignedAttestation | null> {
    const registryUrl =
      this.store.getGuildConfig(guildId)?.registryUrl ?? this.defaultRegistryUrl;
    if (registryUrl) {
      const entry = await this.fetchRegistryEntry(registryUrl, applicationId);
      if (entry?.status === 'revoked') return null;
      if (entry) return this.fetchAttestation(entry.attestation_url);
    }
    const binding = this.store.getBinding(guildId, applicationId);
    return binding ? this.fetchAttestation(binding.attestationUrl) : null;
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
      applicationControl: 'unproven',
    };
  }
}
