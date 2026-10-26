import { readFileSync } from 'node:fs';
import {
  createVerifier,
  type EvmAddress,
  type SignedAttestation,
  type VerifyCoreOptions,
} from '@fiador/verify';
import type { VerifyMcpDeps } from './server.js';

// Environment configuration (SPEC 11.4), names mirroring the badge
// service's: VERIFY_RPC_URL, VERIFY_CONTRACT_ADDRESS,
// VERIFY_TIMEOUT_MS, VERIFY_BADGE_BASE_URL, VERIFY_REGISTRY_FILE.
// There is no key material to configure: the server is read-only and
// keyless by design.
export function depsFromEnv(env: NodeJS.ProcessEnv = process.env): VerifyMcpDeps {
  const coreOptions: VerifyCoreOptions = {};
  if (env.VERIFY_RPC_URL) coreOptions.rpcUrl = env.VERIFY_RPC_URL;
  if (env.VERIFY_CONTRACT_ADDRESS) {
    coreOptions.contractAddress = env.VERIFY_CONTRACT_ADDRESS as EvmAddress;
  }
  if (env.VERIFY_TIMEOUT_MS) {
    const parsed = Number(env.VERIFY_TIMEOUT_MS);
    if (Number.isFinite(parsed) && parsed > 0) coreOptions.timeoutMs = parsed;
  }

  const deps: VerifyMcpDeps = { verifier: createVerifier(coreOptions) };
  if (env.VERIFY_BADGE_BASE_URL) deps.badgeBaseUrl = env.VERIFY_BADGE_BASE_URL;

  if (env.VERIFY_REGISTRY_FILE) {
    // A registry document maps "subjectType:subjectId" to a signed
    // attestation object. It is the deployment's own file (loaded at
    // startup; restart to reload) — the server fetches nothing.
    const raw = readFileSync(env.VERIFY_REGISTRY_FILE, 'utf8');
    const registry = JSON.parse(raw) as Record<string, SignedAttestation>;
    deps.resolver = async (subject) =>
      registry[`${subject.type}:${subject.id}`] ?? null;
  }
  return deps;
}
