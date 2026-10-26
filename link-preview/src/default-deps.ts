// Default dependency wiring for the reference deployment. Everything
// here is deliberately thin and replaceable: the handler's contract is
// LinkPreviewDeps, and this module is the one place that touches the
// network directly.
//
// STUB BOUNDARIES (see README):
// - The attestation fetcher below is a plain HTTPS fetch. Production
//   must swap in the §5.4 fetch-guard machinery (public-address pinning,
//   no redirects, timeout, body cap) — the badge service's fetcher
//   family (W0 spec §4.7) — before this surface is public.
// - The default verifier fails closed (status 'unknown') until the
//   caller wires the real verify core via createVerifier() from
//   @fiador/verify with a live AgentBook reader.

import type { EvmAddress } from '@fiador/verify';

// Public chain constants (W0 spec section 2). Defined locally: the
// verify core does not export them as values.
const AGENTBOOK_CONTRACT: EvmAddress = '0xA23aB2712eA7BBa896930544C7d6636a96b944dA';
const WORLD_CHAIN_NETWORK = 'eip155:480' as const;
import type { Verifier } from '@fiador/verify';
import type { LinkPreviewDeps } from './deps.js';
import type { RegistryDocument } from './registry.js';

export interface DefaultDepsEnv {
  /** URL of the published registry.json. */
  registryUrl?: string;
  /** Canonical base URL, default 'https://fiador.org'. */
  baseUrl?: string;
  /** A real verifier, once the verify core is wired. */
  verifier?: Verifier;
}

function unknownResult(
  address: string,
  failures: ['lookup_failed'] | ['attestation_not_found'],
) {
  return {
    status: 'unknown' as const,
    address: address as `0x${string}`,
    addressTruncated: '0x…',
    humanHash: null,
    failures,
    evidence: {
      checkedAt: new Date().toISOString(),
      source: 'live' as const,
      agentBook: { network: WORLD_CHAIN_NETWORK, contract: AGENTBOOK_CONTRACT },
    },
  };
}

function walletOf(attestation: unknown): string {
  return (
    (attestation as { payload?: { agentWalletAddress?: string } } | null)
      ?.payload?.agentWalletAddress ?? '0x'
  );
}

/** Fail-closed verifier: every check reports 'unknown' + lookup_failed. */
export const failClosedVerifier: Verifier = {
  async verifyAddress(address: string) {
    return unknownResult(address, ['lookup_failed']);
  },
  async verifyAttestation(attestation: unknown) {
    return unknownResult(walletOf(attestation), ['lookup_failed']);
  },
  async resolveStatus(subject) {
    if (subject.kind === 'address') {
      return unknownResult(subject.address, ['lookup_failed']);
    }
    if (subject.kind === 'attestation') {
      return unknownResult(walletOf(subject.attestation), ['lookup_failed']);
    }
    const attestation = await subject.resolveAttestation(subject.subject);
    if (!attestation) return unknownResult('0x', ['attestation_not_found']);
    return unknownResult(walletOf(attestation), ['lookup_failed']);
  },
};

export function createDefaultDeps(env: DefaultDepsEnv = {}): LinkPreviewDeps {
  const registryUrl =
    env.registryUrl ??
    process.env.FIADOR_REGISTRY_URL ??
    'https://fiador.org/registry/registry.json';
  const baseUrl = env.baseUrl ?? process.env.FIADOR_BASE_URL ?? 'https://fiador.org';
  return {
    baseUrl,
    now: () => new Date(),
    verifier: env.verifier ?? failClosedVerifier,
    registrySource: async (): Promise<RegistryDocument> => {
      const res = await fetch(registryUrl, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`registry fetch failed: ${res.status}`);
      return (await res.json()) as RegistryDocument;
    },
    attestationFetcher: async (url: string): Promise<unknown> => {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`attestation fetch failed: ${res.status}`);
      return res.json();
    },
  };
}
