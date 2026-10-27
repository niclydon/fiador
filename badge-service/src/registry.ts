import { readFile } from 'node:fs/promises';
import type { SignedAttestation } from '@fiador/verify';
import { guardedFetchJson } from './guardedFetch.js';

type Subject = { type: string; id: string };
type FetchJson = (url: string) => Promise<unknown>;

export interface RegistrySource {
  file?: string;
  url?: string;
  fetchJson?: FetchJson;
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

/** Resolve against the current file or URL on every request. The
 * service's result cache is keyed by the returned attestation, so
 * registry removal or attestation replacement cannot reuse it. */
export function createRegistryResolver(source: RegistrySource): (subject: Subject) => Promise<SignedAttestation | null> {
  if (source.file && source.url) throw new Error('Choose either REGISTRY_FILE or REGISTRY_URL.');
  const fetchJson = source.fetchJson ?? guardedFetchJson;
  return async (subject) => {
    if (subject.type !== 'discord_application' || (!source.file && !source.url)) return null;
    const registry = source.file
      ? JSON.parse(await readFile(source.file, 'utf8')) as unknown
      : await fetchJson(source.url!);
    const entries = canonicalEntries(registry);
    if (entries) {
      const entry = entries.find((candidate) => candidate.discord_application_id === subject.id);
      if (!entry || entry.status === 'revoked') return null;
      return await fetchJson(entry.attestation_url) as SignedAttestation;
    }
    // Compatibility with self-hosted inline maps used by the first
    // badge-service draft. The canonical public registry uses entries[].
    if (!record(registry)) throw new Error('Invalid registry document.');
    return (registry[`${subject.type}:${subject.id}`] ?? null) as SignedAttestation | null;
  };
}
