// Default dependency wiring for the reference deployment. Everything
// here is deliberately thin and replaceable: the handler's contract is
// LinkPreviewDeps, while this module and guardedFetch own network access.
//
// The attestation fetcher enforces DESIGN §5.4's URL guard; the default
// verifier is the verify core with a live AgentBook reader.

import { createVerifier, type EvmAddress, type Verifier } from '@fiador/verify';
import { guardedFetchJson } from './guardedFetch.js';

// Public chain constants (W0 spec section 2). Defined locally: the
// verify core does not export them as values.
const AGENTBOOK_CONTRACT: EvmAddress = '0xA23aB2712eA7BBa896930544C7d6636a96b944dA';
const WORLD_CHAIN_NETWORK = 'eip155:480' as const;
import type { LinkPreviewDeps } from './deps.js';
import type { RegistryDocument } from './registry.js';

const MAX_REGISTRY_BYTES = 64 * 1024;

async function readRegistry(response: Response): Promise<RegistryDocument> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (declaredLength > MAX_REGISTRY_BYTES) {
    await response.body?.cancel();
    throw new Error('Registry body exceeds 64 KiB.');
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_REGISTRY_BYTES) {
      throw new Error('Registry body exceeds 64 KiB.');
    }
    return JSON.parse(text) as RegistryDocument;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REGISTRY_BYTES) {
        await reader.cancel();
        throw new Error('Registry body exceeds 64 KiB.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as RegistryDocument;
}

export interface DefaultDepsEnv {
  /** URL of the published registry.json. */
  registryUrl?: string;
  /** Canonical base URL, default 'https://fiador.org'. */
  baseUrl?: string;
  /** Override the live verify core, primarily for tests. */
  verifier?: Verifier;
  /** Optional World Chain RPC endpoint; the verify core has a public default. */
  rpcUrl?: string;
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
    'https://fiador.org/registry.json';
  const baseUrl = env.baseUrl ?? process.env.FIADOR_BASE_URL ?? 'https://fiador.org';
  const rpcUrl = env.rpcUrl ?? process.env.FIADOR_RPC_URL;
  return {
    baseUrl,
    now: () => new Date(),
    verifier: env.verifier ?? createVerifier(rpcUrl ? { rpcUrl } : {}),
    registrySource: async (): Promise<RegistryDocument> => {
      const res = await fetch(registryUrl, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`registry fetch failed: ${res.status}`);
      }
      return readRegistry(res);
    },
    attestationFetcher: (url, signal) => guardedFetchJson(url, { signal }),
  };
}
