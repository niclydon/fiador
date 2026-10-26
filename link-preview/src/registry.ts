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

/** registrySource may hand back the full document or a bare entry list. */
export function normalizeEntries(
  doc: RegistryDocument | RegistryEntry[],
): RegistryEntry[] {
  if (Array.isArray(doc)) return doc;
  if (doc && Array.isArray(doc.entries)) return doc.entries;
  return [];
}

export function isTombstone(entry: RegistryEntry): boolean {
  return entry.status === 'revoked';
}
