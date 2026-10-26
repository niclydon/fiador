import { createPublicClient, http, toHex } from 'viem';
import { worldchain } from 'viem/chains';
import type { AgentBookReader, EvmAddress } from './types.js';

// Canonical AgentBook deployment on World Chain (SPEC section 2),
// re-verified at build time against the installed SDK: this constant
// matches AGENT_BOOK_ADDRESS in @worldcoin/agentkit-core 0.2.1.
export const AGENTBOOK_CONTRACT: EvmAddress = '0xA23aB2712eA7BBa896930544C7d6636a96b944dA';

export const AGENTBOOK_ABI = [
  {
    inputs: [{ internalType: 'address', name: '', type: 'address' }],
    name: 'lookupHuman',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// The default reader reads the AgentBook contract directly with viem.
// It deliberately does NOT wrap the AgentKit SDK's
// createAgentBookVerifier: in @worldcoin/agentkit(-core) 0.2.1,
// lookupHuman wraps its readContract in `catch { return null }`, which
// collapses transport failure and genuine non-registration into the
// same null — the exact ambiguity SPEC 3.1 forbids inheriting. This
// reader performs the identical read (same contract, same ABI, same
// uint256 -> hex conversion, 0 means no entry) and lets failures throw,
// so the core can return 'unknown' honestly.
export function createLiveReader(options?: {
  rpcUrl?: string;
  contractAddress?: EvmAddress;
}): AgentBookReader {
  const contract = options?.contractAddress ?? AGENTBOOK_CONTRACT;
  const client = createPublicClient({
    chain: worldchain,
    transport: http(options?.rpcUrl),
  });
  return {
    source: 'live',
    async lookupHuman(address: EvmAddress): Promise<string | null> {
      const value = await client.readContract({
        address: contract,
        abi: AGENTBOOK_ABI,
        functionName: 'lookupHuman',
        args: [address],
      });
      if (value === 0n) return null;
      return toHex(value);
    },
  };
}

// A reader that replays fixed responses, for fixture-driven tests and
// offline consumers. Keys are addresses (matched case-insensitively);
// values are a humanId string, null (no entry), or an Error to throw.
export function createStaticReader(
  entries: Record<string, string | null | Error>,
  source: 'live' | 'fixture' = 'fixture',
): AgentBookReader {
  const map = new Map<string, string | null | Error>();
  for (const [key, value] of Object.entries(entries)) map.set(key.toLowerCase(), value);
  return {
    source,
    async lookupHuman(address: EvmAddress): Promise<string | null> {
      const entry = map.get(address.toLowerCase());
      if (entry instanceof Error) throw entry;
      return entry ?? null;
    },
  };
}
