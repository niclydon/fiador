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

// RPC endpoint policy (7.5 review M17, comment corrected in fix
// pass 2 to match the code exactly): the configured RPC is the
// trust oracle for registration answers — whatever it returns IS
// the lookup result — so a plaintext endpoint is an integrity
// hole, not a preference. Non-https URLs are rejected at
// construction, with one exception: the exact loopback hosts
// 'localhost', '127.0.0.1', and '::1' (the LOOPBACK_HOSTS set
// below) — deliberately NOT the whole 127.0.0.0/8 and not
// shorthand spellings like '127.1', where plaintext never leaves
// the machine (local dev nodes, test stubs). Fail-closed: an
// operator who wants another loopback spelling uses https or one
// of these three.
// The error messages never interpolate the URL: RPC URLs routinely
// carry API keys in their path.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
export function assertRpcUrlAllowed(rpcUrl: string | undefined): void {
  if (rpcUrl === undefined) return;
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new TypeError('malformed RPC URL (expected an https URL, or http on loopback)');
  }
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return;
  throw new TypeError(
    'RPC URL must use https (http is allowed only for loopback endpoints)',
  );
}

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
  assertRpcUrlAllowed(options?.rpcUrl);
  const contract = options?.contractAddress ?? AGENTBOOK_CONTRACT;
  const client = createPublicClient({
    chain: worldchain,
    transport: http(options?.rpcUrl),
  });
  return {
    source: 'live',
    async lookupHuman(address: EvmAddress): Promise<string | null> {
      // Be precise about what this check is (7.5 review M17): the
      // configured RPC is the trust oracle for the answer below — this
      // eth_chainId call does not authenticate it, it only catches the
      // common misconfiguration of pointing a World Chain verifier at
      // an endpoint that answers for a different chain entirely.
      if (await client.getChainId() !== worldchain.id) {
        throw new Error('AgentBook RPC is not World Chain.');
      }
      const value = await client.readContract({
        address: contract,
        abi: AGENTBOOK_ABI,
        functionName: 'lookupHuman',
        args: [address],
      });
      if (value === 0n) return null;
      // The canonical humanId shape is a full 32-byte hex string
      // (7.5 re-review N1): rendering the uint256 unpadded would
      // produce '0x1' for a small value, which the core now —
      // correctly — refuses to treat as a humanId at all.
      return toHex(value, { size: 32 });
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
