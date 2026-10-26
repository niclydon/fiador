// Short-id resolution (DESIGN §6.4).
//
// A short-id is content-derived: the first N characters of the base32
// encoding of SHA-256 over the attestation's canonical signing bytes.
// Any change to the payload changes the id, so a link names one exact
// attestation. Longer ids are supported by computing each candidate's
// id at the requested length (prefix extension), minimum 10.

import { attestationShortId } from '@fiador/verify';
import type { SignedAttestation } from '@fiador/verify';
import type { RegistryEntry } from './registry.js';
import { isTombstone } from './registry.js';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Base32 (lowercase, no padding) of raw digest bytes, truncated to
 * `length` characters. Prefix-consistent with attestationShortId,
 * which streams the same bits off the same digest.
 */
export function base32FromBytes(bytes: Uint8Array, length: number): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= length) break;
  }
  return out.slice(0, length);
}

export function shortIdFromDigestHex(hex: string, length: number): string {
  const clean = hex.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) return '';
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return base32FromBytes(bytes, length);
}

function isPlausibleAttestation(value: unknown): value is SignedAttestation {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.payload === 'object' &&
    v.payload !== null &&
    typeof v.signature === 'string'
  );
}

/** Non-fetch id match for a tombstone: via its recorded payload hash or short-id. */
function tombstoneMatches(entry: RegistryEntry, id: string): boolean {
  if (entry.payload_hash) {
    if (shortIdFromDigestHex(entry.payload_hash, id.length) === id) return true;
  }
  if (entry.short_id) {
    if (entry.short_id === id) return true;
    // A stored id matches a requested id only at its own length or as a
    // strict prefix of a longer recorded id; never the reverse, so a
    // short guess cannot claim a longer link's entry.
    if (id.length < entry.short_id.length && entry.short_id.startsWith(id)) {
      return true;
    }
  }
  return false;
}

export type Resolution =
  | { kind: 'live'; entry: RegistryEntry; attestation: SignedAttestation }
  | { kind: 'revoked'; entry: RegistryEntry }
  | { kind: 'not_found' }
  | { kind: 'lookup_failed'; reason: string };

/**
 * Resolve a short-id against the registry.
 *
 * Order matters: tombstones are matched first, without any fetch, so a
 * revoked entry's card never depends on its old hosting still answering.
 * Live entries are matched by fetching each attestation (through the
 * injected, guarded fetcher) and computing its id at the requested
 * length. Fail-closed: if any live entry cannot be fetched or parsed
 * and nothing matched, the answer is lookup_failed, not not_found —
 * the requested id might be exactly the entry that could not be read.
 */
export async function resolveShortId(
  entries: RegistryEntry[],
  id: string,
  attestationFetcher: (url: string) => Promise<unknown>,
): Promise<Resolution> {
  for (const entry of entries) {
    if (isTombstone(entry) && tombstoneMatches(entry, id)) {
      return { kind: 'revoked', entry };
    }
  }

  let sawFetchFailure = false;
  for (const entry of entries) {
    if (isTombstone(entry)) continue;
    let fetched: unknown;
    try {
      fetched = await attestationFetcher(entry.attestation_url);
    } catch {
      sawFetchFailure = true;
      continue;
    }
    if (!isPlausibleAttestation(fetched)) {
      sawFetchFailure = true;
      continue;
    }
    if (attestationShortId(fetched, id.length) === id) {
      return { kind: 'live', entry, attestation: fetched };
    }
  }

  if (sawFetchFailure) {
    return {
      kind: 'lookup_failed',
      reason: 'an attestation host could not be reached at crawl time',
    };
  }
  return { kind: 'not_found' };
}

/**
 * The application name a surface may show — taken, never invented:
 * the name signed into the attestation, else the name recorded in the
 * registry, else the application id itself, truncated.
 */
export function applicationNameFor(
  entry: RegistryEntry,
  attestation?: SignedAttestation,
): string {
  const signed = attestation?.payload.extra?.discord_application_name;
  if (signed && signed.trim().length > 0) return signed;
  if (entry.name && entry.name.trim().length > 0) return entry.name;
  const appId = entry.discord_application_id;
  return appId.length > 14 ? `${appId.slice(0, 14)}…` : appId;
}
