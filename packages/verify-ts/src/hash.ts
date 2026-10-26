import { sha256, toBytes } from 'viem';
import type { EvmAddress } from './types.js';

// The canonical human hash (SPEC 3.5): sha256 of the domain-separated
// humanId, hex-encoded. CANONICAL, program-wide, frozen for v1: every
// surface that displays a human hash displays this hash for a given
// human. Changing the prefix, algorithm, input form, or encoding is a
// breaking program-level change.
export function hashHumanId(humanId: string): string {
  return sha256(toBytes(`w0-human-v1:${humanId}`)).slice(2);
}

// '0x7d7D…6097f' form: first 6 characters, ellipsis, last 5.
export function truncateAddress(address: EvmAddress | string): string {
  return `${address.slice(0, 6)}…${address.slice(-5)}`;
}
