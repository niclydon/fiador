// Short ids for /v/ links (DESIGN §6.4): a W1 link-preview concern,
// computed over the verify core's canonical form. The id is the first
// `length` characters of the base32 encoding of SHA-256 over the
// attestation's canonical signing bytes (canonicalAttestationMessage),
// so any change to the payload changes the id.

import { createHash } from 'node:crypto';
import { canonicalAttestationMessage } from '@fiador/verify';
import type { SignedAttestation } from '@fiador/verify';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function shortIdFromDigest(digest: Buffer, length = 10): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of digest) {
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

export function attestationShortId(attestation: SignedAttestation, length = 10): string {
  const digest = createHash('sha256')
    .update(canonicalAttestationMessage(attestation.payload), 'utf8')
    .digest();
  return shortIdFromDigest(digest, length);
}
