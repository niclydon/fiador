// Injected dependencies (DESIGN §6.4 hosting posture): the handler
// depends only on the verify core and the published attestation
// registry. Everything platform- or transport-shaped is injected here,
// so a hosting move is a relocation of the thin adapter, not a rewrite.

import type { Verifier } from '@fiador/verify';
import type { RegistryDocument, RegistryEntry } from './registry.js';

export interface LinkPreviewDeps {
  /** Loads the published registry (document or bare entry list). */
  registrySource: () => Promise<RegistryDocument | RegistryEntry[]>;
  /**
   * Guarded fetch of one attestation_url, returning its parsed JSON.
   * The production implementation is the §5.4 fetch-guard machinery
   * (HTTPS only, public addresses only, no redirects, timeout, body
   * cap) — the same fetcher family as the badge service (W0 spec §4.7).
   */
  attestationFetcher: (url: string) => Promise<unknown>;
  /** The verify core. Its results cross to this surface only through
   *  toPublicVerifyResult — never as the internal shape. */
  verifier: Verifier;
  /** Canonical base, e.g. 'https://fiador.org' (no trailing slash). */
  baseUrl: string;
  /** Injectable clock for deterministic cards and tests. */
  now: () => Date;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}
