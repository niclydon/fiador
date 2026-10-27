import { readFile } from 'node:fs/promises';
import type { SignedAttestation } from '@fiador/verify';
import { guardedFetchJson } from './guardedFetch.js';

type Subject = { type: string; id: string };
type FetchJson = (url: string) => Promise<unknown>;
export type VersionedRegistryResolver = ((subject: Subject) => Promise<SignedAttestation | null>) & {
  currentVersion(): number;
};

export interface RegistrySource {
  file?: string;
  url?: string;
  fetchJson?: FetchJson;
  now?: () => number;
}

interface RegistryEntry {
  discord_application_id: string;
  attestation_url: string;
  status?: 'revoked';
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalEntries(value: unknown): RegistryEntry[] | null {
  if (!record(value) || !('entries' in value)) return null;
  if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error('Invalid registry document.');
  const seen = new Set<string>();
  return value.entries.map((item: unknown) => {
    if (!record(item) || typeof item.discord_application_id !== 'string' ||
        !/^\d{17,20}$/.test(item.discord_application_id) ||
        typeof item.attestation_url !== 'string' ||
        (item.status !== undefined && item.status !== 'revoked') ||
        seen.has(item.discord_application_id)) {
      throw new Error('Invalid registry entry.');
    }
    const url = new URL(item.attestation_url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid attestation URL.');
    seen.add(item.discord_application_id);
    return {
      discord_application_id: item.discord_application_id,
      attestation_url: item.attestation_url,
      ...(item.status === 'revoked' ? { status: 'revoked' as const } : {}),
    };
  });
}

export function validateCanonicalRegistry(value: unknown): void {
  if (canonicalEntries(value) === null) throw new Error('Invalid registry document.');
}

const SOURCE_TTL_MS = 300_000;

/** Registry and attestation data share one bounded 300-second source
 * window. Single flights prevent a burst of badge requests from
 * multiplying registry and attestation fetches. */
export function createRegistryResolver(source: RegistrySource): VersionedRegistryResolver {
  if (source.file && source.url) throw new Error('Choose either REGISTRY_FILE or REGISTRY_URL.');
  const fetchJson = source.fetchJson ?? guardedFetchJson;
  const now = source.now ?? Date.now;
  type RegistrySnapshot = { document: Record<string, unknown>; entries: RegistryEntry[] | null };
  let registryCache: { value: RegistrySnapshot; loadedAtMs: number } | undefined;
  let registryFlight: Promise<RegistrySnapshot> | undefined;
  const attestationCache = new Map<string, { value: SignedAttestation; loadedAtMs: number }>();
  const attestationFlights = new Map<string, Promise<SignedAttestation>>();
  let generation = 0;
  let nextExpiryAtMs = Infinity;

  // A request crossing a source TTL must not join a flight that
  // started with the prior registry/attestation snapshot. Advance
  // once per expiry boundary, even while a refresh is still pending.
  function currentVersion(nowMs = now()): number {
    if (nowMs < nextExpiryAtMs) return generation;
    generation++;
    nextExpiryAtMs = Infinity;
    // A new source window must not join a fetch begun in the old one.
    // Old flights may complete for old callers, but cannot populate
    // caches used by new requests.
    registryFlight = undefined;
    attestationFlights.clear();
    if (registryCache && registryCache.loadedAtMs + SOURCE_TTL_MS > nowMs) {
      nextExpiryAtMs = registryCache.loadedAtMs + SOURCE_TTL_MS;
    }
    for (const cached of attestationCache.values()) {
      if (cached.loadedAtMs + SOURCE_TTL_MS > nowMs) {
        nextExpiryAtMs = Math.min(nextExpiryAtMs, cached.loadedAtMs + SOURCE_TTL_MS);
      }
    }
    return generation;
  }

  async function loadRegistry(): Promise<RegistrySnapshot> {
    const nowMs = now();
    currentVersion(nowMs);
    if (registryCache && nowMs - registryCache.loadedAtMs < SOURCE_TTL_MS) return registryCache.value;
    if (registryFlight) return registryFlight;
    const flightGeneration = generation;
    const flight = (async () => {
      const document = source.file
        ? JSON.parse(await readFile(source.file, 'utf8')) as unknown
        : await fetchJson(source.url!);
      const entries = canonicalEntries(document);
      if (!record(document)) throw new Error('Invalid registry document.');
      const snapshot = { document, entries };
      if (currentVersion() === flightGeneration) {
        const loadedAtMs = now();
        registryCache = { value: snapshot, loadedAtMs };
        nextExpiryAtMs = Math.min(nextExpiryAtMs, loadedAtMs + SOURCE_TTL_MS);
        for (const [url, cached] of attestationCache) {
          if (now() - cached.loadedAtMs >= SOURCE_TTL_MS) attestationCache.delete(url);
        }
      }
      return snapshot;
    })();
    registryFlight = flight;
    try {
      return await flight;
    } finally {
      if (registryFlight === flight) registryFlight = undefined;
    }
  }

  async function loadAttestation(url: string): Promise<SignedAttestation> {
    const nowMs = now();
    currentVersion(nowMs);
    const cached = attestationCache.get(url);
    if (cached && nowMs - cached.loadedAtMs < SOURCE_TTL_MS) return cached.value;
    const pending = attestationFlights.get(url);
    if (pending) return pending;
    const flightGeneration = generation;
    const flight = (async () => {
      const value = await fetchJson(url) as SignedAttestation;
      if (currentVersion() === flightGeneration) {
        const loadedAtMs = now();
        attestationCache.set(url, { value, loadedAtMs });
        nextExpiryAtMs = Math.min(nextExpiryAtMs, loadedAtMs + SOURCE_TTL_MS);
      }
      return value;
    })();
    attestationFlights.set(url, flight);
    try {
      return await flight;
    } finally {
      if (attestationFlights.get(url) === flight) attestationFlights.delete(url);
    }
  }

  const resolve = async (subject: Subject) => {
    if (subject.type !== 'discord_application' || (!source.file && !source.url)) return null;
    const { document: registry, entries } = await loadRegistry();
    if (entries) {
      const entry = entries.find((candidate) => candidate.discord_application_id === subject.id);
      if (!entry || entry.status === 'revoked') return null;
      return await loadAttestation(entry.attestation_url);
    }
    // Compatibility with self-hosted inline maps used by the first
    // badge-service draft. The canonical public registry uses entries[].
    return (registry[`${subject.type}:${subject.id}`] ?? null) as SignedAttestation | null;
  };
  return Object.assign(resolve, { currentVersion });
}
