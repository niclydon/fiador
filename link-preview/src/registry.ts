// Registry shape (DESIGN §3.4). The registry is a published JSON file;
// entries are the only discovery input this surface has. No accounts,
// no database: resolution derives everything from the entries plus the
// attestations they point at.

export interface RegistryEntry {
  discord_application_id: string;
  attestation_url: string;
  /** 'revoked' marks a tombstone: the id stays resolvable so old links
   *  render an honest revoked card instead of decaying to not-found. */
  status?: string;
  /** Optional display name recorded in the registry. A name source of
   *  last resort before the application id itself — never invented. */
  name?: string;
  submitted_by?: string;
  added_at?: string;
  /** sha256 (hex) of the attestation's canonical signing bytes, recorded
   *  at publish time (§3.4 derived index). Lets a tombstone's short-id
   *  be matched without fetching the attestation it once named. */
  payload_hash?: string;
  /** The entry's short-id, when recorded explicitly at publish time. */
  short_id?: string;
}

export interface RegistryDocument {
  version?: number;
  generated_at?: string;
  entries: RegistryEntry[];
}

const CANONICAL_PAYLOAD_HASH = /^[0-9a-f]{64}$/;

/** registrySource may hand back the full document or a bare entry list. */
export function normalizeEntries(
  doc: RegistryDocument | RegistryEntry[],
): RegistryEntry[] {
  const entries = Array.isArray(doc) ? doc : doc?.entries;
  if (
    !Array.isArray(entries) ||
    (!Array.isArray(doc) && doc.version !== undefined && doc.version !== 1)
  ) {
    throw new Error('Malformed registry document.');
  }
  for (const entry of entries) {
    if (
      !entry || typeof entry !== 'object' ||
      typeof entry.discord_application_id !== 'string' ||
      typeof entry.attestation_url !== 'string' ||
      (entry.status !== undefined && entry.status !== 'revoked') ||
      (entry.name !== undefined && typeof entry.name !== 'string') ||
      (entry.payload_hash !== undefined &&
        (typeof entry.payload_hash !== 'string' || !CANONICAL_PAYLOAD_HASH.test(entry.payload_hash))) ||
      (entry.status === 'revoked' && entry.payload_hash === undefined) ||
      (entry.short_id !== undefined && typeof entry.short_id !== 'string')
    ) {
      throw new Error('Malformed registry entry.');
    }
    let url: URL;
    try {
      url = new URL(entry.attestation_url);
    } catch {
      throw new Error('Malformed registry attestation URL.');
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('Malformed registry attestation URL.');
    }
  }
  return entries;
}

export function isTombstone(entry: RegistryEntry): boolean {
  return entry.status === 'revoked';
}
