import { describe, expect, it } from 'vitest';
import { createVerifier, truncateAddress } from '../src/index.js';

// Live-chain tests (SPEC 7.4): behind LIVE_AGENTBOOK=1, excluded from
// the default run. They assert STATUS ONLY and log truncated addresses
// and hashes at most — never a raw humanId (SPEC 4.9 dispositions).
//   LIVE_REGISTERED_ADDRESS=0x...   a wallet known to be registered
//   LIVE_UNREGISTERED_ADDRESS=0x... a wallet known not to be
const enabled = process.env.LIVE_AGENTBOOK === '1';
const registered = process.env.LIVE_REGISTERED_ADDRESS;
const unregistered = process.env.LIVE_UNREGISTERED_ADDRESS;

describe.skipIf(!enabled || !registered)('live AgentBook', () => {
  it('known registered wallet verifies against the real contract', async () => {
    const verifier = createVerifier({ timeoutMs: 15000 });
    const result = await verifier.verifyAddress(registered as string);
    console.log(
      `live registered ${truncateAddress(result.address)} -> ${result.status} hash=${result.humanHash?.slice(0, 12)}…`,
    );
    expect(result.status).toBe('verified');
    expect(result.humanHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe.skipIf(!enabled || !unregistered)('live AgentBook', () => {
  it('known unregistered wallet reports unregistered', async () => {
    const verifier = createVerifier({ timeoutMs: 15000 });
    const result = await verifier.verifyAddress(unregistered as string);
    console.log(
      `live unregistered ${truncateAddress(result.address)} -> ${result.status}`,
    );
    expect(result.status).toBe('unregistered');
    expect(result.failures).toEqual(['not_registered']);
  });
});

describe.skipIf(!enabled)('live AgentBook failure honesty', () => {
  it('a dead RPC endpoint yields unknown, never unregistered', async () => {
    const verifier = createVerifier({
      rpcUrl: 'http://127.0.0.1:9',
      timeoutMs: 4000,
    });
    const result = await verifier.verifyAddress(
      '0x000000000000000000000000000000000000dEaD',
    );
    console.log(`live dead-rpc -> ${result.status} ${result.failures.join(',')}`);
    expect(result.status).toBe('unknown');
    expect(result.failures[0]).toMatch(/^lookup_(failed|timeout)$/);
  });
});
