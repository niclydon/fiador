import { readFileSync } from 'node:fs';
import {
  createVerifier,
  type EvmAddress,
  type SignedAttestation,
  type Verifier,
} from '@fiador/verify';
import { parseJsonStrict, DuplicateJsonKeyError } from './json.js';
import type { VerifyMcpDeps } from './server.js';

// Environment configuration (SPEC 11.4), names mirroring the badge
// service's: VERIFY_RPC_URL, VERIFY_CONTRACT_ADDRESS,
// VERIFY_TIMEOUT_MS, VERIFY_BADGE_BASE_URL, VERIFY_REGISTRY_FILE.
// There is no key material to configure: the server is read-only and
// keyless by design.
//
// Error discipline (7.5 review M14/M16): configuration problems are
// STARTUP errors with fixed, sanitised messages. A message names the
// variable and the problem class; it never interpolates a configured
// value, a file's content, or an underlying parser error — config
// values (RPC URLs especially) routinely carry secrets. An
// explicitly-set invalid value is an error, never a silent default.

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function fail(message: string): never {
  throw new ConfigError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Attestation shape (7.5 re-review m5): a registry value promises a
// signed attestation object — a payload object, a signature string,
// and a declared signatureType in the protocol's set. Anything less
// is rejected by loadRegistryFile at startup with the sanitised
// error, instead of surfacing later as a verification anomaly.
function isAttestationShape(value: Record<string, unknown>): boolean {
  return (
    isPlainObject(value.payload) &&
    typeof value.signature === 'string' &&
    (value.signatureType === 'eip191' || value.signatureType === 'eip1271')
  );
}

export function parseTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    fail('VERIFY_TIMEOUT_MS must be an integer between 100 and 60000');
  }
  const value = Number(raw);
  if (value < 100 || value > 60000) {
    fail('VERIFY_TIMEOUT_MS must be an integer between 100 and 60000');
  }
  return value;
}

// Validate and normalise the badge base URL at startup (7.5 review
// m6): http/https only, no query or fragment (badge URLs are built by
// path interpolation; a smuggled query would ride along on every
// badge link the tool returns).
export function parseBadgeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail('VERIFY_BADGE_BASE_URL must be a valid http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail('VERIFY_BADGE_BASE_URL must be a valid http(s) URL');
  }
  // Credentials are never republished (7.5 re-review m6): a base
  // URL carrying userinfo would embed those credentials in every
  // badge URL the tool hands out. Strip them, like the query and
  // fragment below.
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

// Registry file (7.5 review m5). File format: a JSON object mapping
// "type:id" to a signed attestation object. Keys are parsed at the
// FIRST colon (subject types never contain one; ids may), and the
// in-memory map is keyed by a JSON-encoded [type, id] pair, so the
// composite key is unambiguous regardless of what either leg holds.
// Shape is validated here, at startup, with sanitised errors — not
// discovered later and blamed on the RPC.
export function loadRegistryFile(
  path: string,
): (subject: { type: string; id: string }) => Promise<SignedAttestation | null> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    fail('VERIFY_REGISTRY_FILE could not be read');
  }
  let parsed: unknown;
  try {
    parsed = parseJsonStrict(raw);
  } catch (err) {
    if (err instanceof DuplicateJsonKeyError) {
      fail('VERIFY_REGISTRY_FILE contains duplicate keys');
    }
    fail('VERIFY_REGISTRY_FILE is not valid JSON');
  }
  if (!isPlainObject(parsed)) {
    fail('VERIFY_REGISTRY_FILE must contain a JSON object mapping "type:id" to attestation objects');
  }
  const map = new Map<string, SignedAttestation>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const sep = key.indexOf(':');
    const typeLeg = sep > 0 ? key.slice(0, sep) : '';
    const idLeg = sep > 0 ? key.slice(sep + 1) : '';
    // Both legs are validated at startup (7.5 re-review m5): a leg
    // padded with whitespace can never match a resolver query —
    // subjects are exact strings — so the entry would be silently
    // unreachable, and a value that is not attestation-shaped is a
    // configuration error here, not a resolve-time surprise.
    if (
      sep <= 0 ||
      idLeg.length === 0 ||
      typeLeg !== typeLeg.trim() ||
      idLeg !== idLeg.trim() ||
      !isPlainObject(value) ||
      !isAttestationShape(value)
    ) {
      fail('VERIFY_REGISTRY_FILE keys must have the form "type:id" and values must be attestation objects');
    }
    const composite = JSON.stringify([key.slice(0, sep), key.slice(sep + 1)]);
    if (map.has(composite)) {
      fail('VERIFY_REGISTRY_FILE contains duplicate keys');
    }
    map.set(composite, value as unknown as SignedAttestation);
  }
  return async (subject) => map.get(JSON.stringify([subject.type, subject.id])) ?? null;
}

export function depsFromEnv(env: NodeJS.ProcessEnv = process.env): VerifyMcpDeps {
  const coreOptions: Parameters<typeof createVerifier>[0] = {};
  if (env.VERIFY_RPC_URL) coreOptions.rpcUrl = env.VERIFY_RPC_URL;
  if (env.VERIFY_CONTRACT_ADDRESS) {
    coreOptions.contractAddress = env.VERIFY_CONTRACT_ADDRESS as EvmAddress;
  }
  const timeoutMs = parseTimeoutMs(env.VERIFY_TIMEOUT_MS);
  if (timeoutMs !== undefined) coreOptions.timeoutMs = timeoutMs;

  let verifier: Verifier;
  try {
    verifier = createVerifier(coreOptions);
  } catch {
    fail('invalid verifier configuration: check VERIFY_CONTRACT_ADDRESS and VERIFY_RPC_URL');
  }

  const deps: VerifyMcpDeps = { verifier };
  if (env.VERIFY_BADGE_BASE_URL) {
    deps.badgeBaseUrl = parseBadgeBaseUrl(env.VERIFY_BADGE_BASE_URL);
  }
  if (env.VERIFY_REGISTRY_FILE) {
    deps.resolver = loadRegistryFile(env.VERIFY_REGISTRY_FILE);
  }
  return deps;
}
