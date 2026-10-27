import { readFileSync, statSync } from 'node:fs';
import {
  createVerifier,
  type EvmAddress,
  type SignedAttestation,
  type VerifyCoreOptions,
} from '@fiador/verify';
import { createRegistryResolver, validateCanonicalRegistry } from './registry.js';
import type { BadgeServiceDeps } from './service.js';

// Environment configuration (SPEC 4.8): environment only, values
// never committed. Names mirror the verify MCP package's (SPEC
// 11.4): VERIFY_RPC_URL, VERIFY_CONTRACT_ADDRESS, VERIFY_TIMEOUT_MS,
// VERIFY_REGISTRY_FILE; the SPEC 4.8 spellings (WORLDCHAIN_RPC_URL,
// AGENTBOOK_CONTRACT, REGISTRY_FILE) are accepted as fallbacks.
// PORT / BADGE_PORT select the listen port, BADGE_HOST the bind
// address, BADGE_PUBLIC_BASE_URL pins the base used in JSON badge
// URLs, CACHE_* / RATE_LIMIT_* / LOOKUP_* / REGISTRY_* override the
// SPEC 4.6 proposals.
//
// Numeric configuration is strict (the M16 standard): an explicitly
// set zero, negative, or non-integer value for any numeric knob is
// a startup error naming the variable, never a silent disablement
// or a silent default.
//
// No secret is required to run this service at all: there is no key
// to configure, which is itself a stated property (SPEC 4.8).

/** A configuration failure whose message is a fixed, sanitised
 * string: it names the variable and the problem class only, never
 * a file's content, a value beyond the variable's own name, or a
 * stack. main.ts prints it verbatim and exits. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function strictInt(
  env: NodeJS.ProcessEnv,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const fail = () => {
    throw new ConfigError(`invalid value for ${name}: expected an integer in [${min}, ${max}]`);
  };
  if (!/^-?\d+$/.test(raw.trim())) fail();
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail();
  return parsed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAttestationShape(value: unknown): value is SignedAttestation {
  if (!isPlainObject(value)) return false;
  return (
    isPlainObject(value.payload) &&
    typeof value.signature === 'string' &&
    value.signature.length > 0 &&
    typeof value.signatureType === 'string' &&
    value.signatureType.length > 0
  );
}

/** The canonical subject key, used for EVERY keyed structure in the
 * service (result cache, single-flight, registry, ETags): the JSON
 * encoding of the [type, id] pair. String concatenation with a
 * separator is NOT a key: ("a", "x:y") and ("a:x", "y") collide
 * under `${type}:${id}` and are distinct subjects. Address subjects
 * are canonicalised (type 'address', lowercase ID) before keying. */
export function canonicalSubject(type: string, id: string): [string, string] {
  if (type.toLowerCase() === 'address') return ['address', id.toLowerCase()];
  return [type, id];
}

export function subjectKey(type: string, id: string): string {
  return JSON.stringify(canonicalSubject(type, id));
}

export interface RegistrySource {
  resolve(subject: { type: string; id: string }): Promise<SignedAttestation | null>;
  /** Reload the backing file if the refresh interval has elapsed.
   * A failed reload keeps the last good registry. */
  refreshIfDue(nowMs: number): void;
  /** Bumps whenever a reload actually swaps the registry content,
   * so the service can drop results cached against the old one:
   * a removed attestation takes effect at refresh, not at some
   * later cache expiry. */
  readonly version: number;
}

/** A registry file (SPEC 4.2 step 2, 4.6): a JSON object mapping
 * subject type -> subject ID -> signed attestation object. The
 * nested shape (rather than a flat "type:id" key) is what makes
 * every (type, id) pair unambiguous by construction. Loaded at
 * startup (a missing, oversized, unparseable, or wrongly-shaped
 * file is a clean startup error) and reloaded on the refresh
 * interval (default 300 s, SPEC 4.6) without a restart: removals
 * take effect on the next refresh. After 24 h without a successful
 * load, entries are treated as absent (SPEC 4.6 ceiling). */
export class FileRegistry implements RegistrySource {
  private entries = new Map<string, SignedAttestation>();
  private lastAttemptMs = 0;
  private lastSuccessMs = 0;
  private lastStamp: string | null = null;
  private versionCounter = 0;

  get version(): number {
    return this.versionCounter;
  }

  constructor(
    private readonly file: string,
    private readonly varName: string,
    private readonly options: {
      refreshMs?: number;
      maxBytes?: number;
      now?: () => number;
      log?: (message: string) => void;
    } = {},
  ) {}

  private get refreshMs(): number {
    return this.options.refreshMs ?? 300_000;
  }
  private get maxBytes(): number {
    return this.options.maxBytes ?? 1_048_576;
  }
  private stamp(): string | null {
    try {
      const st = statSync(this.file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  /** Parse + validate a registry document into the keyed map.
   * Throws ConfigError with a fixed message on any problem. */
  private parse(raw: string): Map<string, SignedAttestation> {
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      throw new ConfigError(`${this.varName}: registry file is not valid JSON`);
    }
    if (!isPlainObject(doc)) {
      throw new ConfigError(`${this.varName}: registry file must be a JSON object of subject types`);
    }
    const out = new Map<string, SignedAttestation>();
    for (const [type, byId] of Object.entries(doc)) {
      if (!isPlainObject(byId)) {
        throw new ConfigError(`${this.varName}: registry entry for a subject type must be an object`);
      }
      for (const [id, attestation] of Object.entries(byId)) {
        if (!isAttestationShape(attestation)) {
          throw new ConfigError(`${this.varName}: registry value is not a signed attestation`);
        }
        out.set(subjectKey(type, id), attestation);
      }
    }
    return out;
  }

  private readAndParse(): Map<string, SignedAttestation> {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      throw new ConfigError(`${this.varName}: registry file could not be read`);
    }
    if (size > this.maxBytes) {
      throw new ConfigError(`${this.varName}: registry file exceeds the size limit`);
    }
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      throw new ConfigError(`${this.varName}: registry file could not be read`);
    }
    if (Buffer.byteLength(raw, 'utf8') > this.maxBytes) {
      throw new ConfigError(`${this.varName}: registry file exceeds the size limit`);
    }
    return this.parse(raw);
  }

  /** Initial load. Any failure is a startup error (ConfigError). */
  loadInitial(): void {
    this.entries = this.readAndParse();
    const nowMs = (this.options.now ?? Date.now)();
    this.lastAttemptMs = nowMs;
    this.lastSuccessMs = nowMs;
    this.lastStamp = this.stamp();
  }

  refreshIfDue(nowMs: number): void {
    if (nowMs - this.lastAttemptMs < this.refreshMs) return;
    this.lastAttemptMs = nowMs;
    const stamp = this.stamp();
    if (stamp !== null && stamp === this.lastStamp) return; // unchanged on disk
    try {
      this.entries = this.readAndParse();
      this.lastSuccessMs = nowMs;
      this.lastStamp = this.stamp();
      this.versionCounter++;
    } catch {
      // Keep the last good registry; one fixed, sanitised line.
      (this.options.log ?? console.error)('[badge-service] registry reload failed; keeping last good registry');
    }
  }

  async resolve(subject: { type: string; id: string }): Promise<SignedAttestation | null> {
    const nowMs = (this.options.now ?? Date.now)();
    // SPEC 4.6: a registry not successfully loaded for 24 h is
    // treated as absent rather than served stale forever.
    if (nowMs - this.lastSuccessMs > 86_400_000) return null;
    return this.entries.get(subjectKey(subject.type, subject.id)) ?? null;
  }

  get size(): number {
    return this.entries.size;
  }
}

export function depsFromEnv(env: NodeJS.ProcessEnv = process.env): BadgeServiceDeps {
  const coreOptions: VerifyCoreOptions = {};
  const rpcUrl = env.VERIFY_RPC_URL ?? env.WORLDCHAIN_RPC_URL;
  if (rpcUrl) coreOptions.rpcUrl = rpcUrl;
  const contract = env.VERIFY_CONTRACT_ADDRESS ?? env.AGENTBOOK_CONTRACT;
  if (contract) coreOptions.contractAddress = contract as EvmAddress;
  const timeoutMs = strictInt(env, 'VERIFY_TIMEOUT_MS', 100, 60_000);
  if (timeoutMs !== undefined) coreOptions.timeoutMs = timeoutMs;

  const deps: BadgeServiceDeps = { verifier: createVerifier(coreOptions) };

  if (env.BADGE_PUBLIC_BASE_URL) {
    let parsed: URL;
    try {
      parsed = new URL(env.BADGE_PUBLIC_BASE_URL);
    } catch {
      throw new ConfigError('invalid value for BADGE_PUBLIC_BASE_URL: expected an http(s) URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ConfigError('invalid value for BADGE_PUBLIC_BASE_URL: expected an http(s) URL');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash ||
        env.BADGE_PUBLIC_BASE_URL.includes('?') || env.BADGE_PUBLIC_BASE_URL.includes('#')) {
      throw new ConfigError('invalid value for BADGE_PUBLIC_BASE_URL: expected an http(s) URL without credentials, query, or fragment');
    }
    deps.publicBaseUrl = parsed.toString();
  }
  if (env.RATE_LIMIT_TRUSTED_PROXIES) {
    deps.trustedProxyIps = env.RATE_LIMIT_TRUSTED_PROXIES.split(',').map((ip) => ip.trim()).filter(Boolean);
  }

  const registryFile = env.VERIFY_REGISTRY_FILE ?? env.REGISTRY_FILE;
  const registryUrl = env.VERIFY_REGISTRY_URL ?? env.REGISTRY_URL;
  if (registryFile && registryUrl) throw new ConfigError('choose either REGISTRY_FILE or REGISTRY_URL');
  if (registryUrl) deps.resolveAttestation = createRegistryResolver({ url: registryUrl });
  if (registryFile) {
    const varName = env.VERIFY_REGISTRY_FILE !== undefined ? 'VERIFY_REGISTRY_FILE' : 'REGISTRY_FILE';
    const refreshMs = strictInt(env, 'REGISTRY_REFRESH_MS', 1, 3_600_000);
    const maxBytes = strictInt(env, 'REGISTRY_MAX_BYTES', 1024, 67_108_864);
    const registry = new FileRegistry(registryFile, varName, {
      ...(refreshMs !== undefined ? { refreshMs } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
    });
    try {
      registry.loadInitial();
      deps.registrySource = registry;
      deps.resolveAttestation = (subject) => registry.resolve(subject);
    } catch (error) {
      // The public entries[] registry is separate from the legacy
      // inline map. Probe it only after the bounded FileRegistry read
      // rejected that map, and validate it before accepting startup.
      let document: unknown;
      try {
        if (statSync(registryFile).size > (maxBytes ?? 1_048_576)) throw error;
        const raw = readFileSync(registryFile, 'utf8');
        if (Buffer.byteLength(raw, 'utf8') > (maxBytes ?? 1_048_576)) throw error;
        document = JSON.parse(raw) as unknown;
      } catch {
        throw error;
      }
      if (!isPlainObject(document) || document.version !== 1 || !Array.isArray(document.entries)) throw error;
      try {
        validateCanonicalRegistry(document);
      } catch {
        throw new ConfigError(`${varName}: invalid canonical registry document`);
      }
      deps.resolveAttestation = createRegistryResolver({ file: registryFile });
    }
  }

  const assign = <K extends keyof BadgeServiceDeps>(key: K, value: number | undefined) => {
    if (value !== undefined) deps[key] = value as BadgeServiceDeps[K];
  };
  assign('cacheTtlVerifiedMs', strictInt(env, 'CACHE_TTL_VERIFIED_MS', 1, 86_400_000));
  assign('cacheTtlNegativeMs', strictInt(env, 'CACHE_TTL_NEGATIVE_MS', 1, 86_400_000));
  assign('staleOnErrorMs', strictInt(env, 'STALE_ON_ERROR_MS', 1, 86_400_000));
  assign('rateLimitMax', strictInt(env, 'RATE_LIMIT_MAX', 1, 100_000));
  assign('rateLimitWindowMs', strictInt(env, 'RATE_LIMIT_WINDOW_MS', 1, 3_600_000));
  assign('cacheMaxEntries', strictInt(env, 'CACHE_MAX_ENTRIES', 1, 100_000));
  assign('maxConcurrentLookups', strictInt(env, 'MAX_CONCURRENT_LOOKUPS', 1, 1_000));
  assign('lookupQueueMax', strictInt(env, 'LOOKUP_QUEUE_MAX', 1, 10_000));
  assign('lookupDeadlineMs', strictInt(env, 'LOOKUP_DEADLINE_MS', 100, 120_000));
  assign('requestTimeoutMs', strictInt(env, 'BADGE_REQUEST_TIMEOUT_MS', 100, 5_000));
  if (contract) deps.agentBookContract = contract as EvmAddress;
  return deps;
}

export function portFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const name = env.PORT !== undefined ? 'PORT' : env.BADGE_PORT !== undefined ? 'BADGE_PORT' : null;
  if (name === null) return 8788;
  const parsed = strictInt(env, name, 1, 65_535);
  return parsed ?? 8788;
}

/** Bind address: loopback by default (the posture PR #33 set for
 * the MCP service). BADGE_HOST overrides it; main.ts warns loudly
 * on a non-loopback bind, because this service is unauthenticated
 * by design and a wildcard bind is an exposure decision, not a
 * default. */
export function hostFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.BADGE_HOST ?? '127.0.0.1';
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
