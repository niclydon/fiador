import {
  createVerifier,
  type EvmAddress,
  type VerifyCoreOptions,
} from '@fiador/verify';
import { createRegistryResolver } from './registry.js';
import type { BadgeServiceDeps } from './service.js';

// Environment configuration (SPEC 4.8): environment only, values
// never committed. Names mirror the verify MCP package's (SPEC
// 11.4): VERIFY_RPC_URL, VERIFY_CONTRACT_ADDRESS, VERIFY_TIMEOUT_MS,
// VERIFY_REGISTRY_FILE; the SPEC 4.8 spellings (WORLDCHAIN_RPC_URL,
// AGENTBOOK_CONTRACT, REGISTRY_FILE/REGISTRY_URL) are accepted.
// PORT / BADGE_PORT select the listen port, BADGE_PUBLIC_BASE_URL
// pins the base used in JSON badge URLs, CACHE_TTL_* / STALE_ON_ERROR_MS
// / RATE_LIMIT_* override the SPEC 4.6 proposals.
//
// No secret is required to run this service at all: there is no key
// to configure, which is itself a stated property (SPEC 4.8).
export function depsFromEnv(env: NodeJS.ProcessEnv = process.env): BadgeServiceDeps {
  const coreOptions: VerifyCoreOptions = {};
  const rpcUrl = env.VERIFY_RPC_URL ?? env.WORLDCHAIN_RPC_URL;
  if (rpcUrl) coreOptions.rpcUrl = rpcUrl;
  const contract = env.VERIFY_CONTRACT_ADDRESS ?? env.AGENTBOOK_CONTRACT;
  if (contract) coreOptions.contractAddress = contract as EvmAddress;
  const timeout = env.VERIFY_TIMEOUT_MS ?? env.LOOKUP_TIMEOUT_MS;
  if (timeout) {
    const parsed = Number(timeout);
    if (Number.isFinite(parsed) && parsed > 0) coreOptions.timeoutMs = parsed;
  }

  const deps: BadgeServiceDeps = { verifier: createVerifier(coreOptions) };
  if (env.BADGE_PUBLIC_BASE_URL) deps.publicBaseUrl = env.BADGE_PUBLIC_BASE_URL;

  const registryFile = env.VERIFY_REGISTRY_FILE ?? env.REGISTRY_FILE;
  const registryUrl = env.VERIFY_REGISTRY_URL ?? env.REGISTRY_URL;
  if (registryFile || registryUrl) deps.resolveAttestation = createRegistryResolver({
    ...(registryFile ? { file: registryFile } : {}),
    ...(registryUrl ? { url: registryUrl } : {}),
  });

  const num = (value: string | undefined) => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const assign = <K extends keyof BadgeServiceDeps>(key: K, value: number | undefined) => {
    if (value !== undefined) deps[key] = value as BadgeServiceDeps[K];
  };
  assign('cacheTtlVerifiedMs', num(env.CACHE_TTL_VERIFIED_MS));
  assign('cacheTtlNegativeMs', num(env.CACHE_TTL_NEGATIVE_MS));
  assign('staleOnErrorMs', num(env.STALE_ON_ERROR_MS));
  assign('rateLimitMax', num(env.RATE_LIMIT_MAX));
  assign('rateLimitWindowMs', num(env.RATE_LIMIT_WINDOW_MS));
  if (env.RATE_LIMIT_TRUSTED_PROXIES) {
    deps.trustedProxyIps = env.RATE_LIMIT_TRUSTED_PROXIES.split(',').map((ip) => ip.trim()).filter(Boolean);
  }
  return deps;
}

export function portFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.PORT ?? env.BADGE_PORT ?? 8788);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8788;
}
