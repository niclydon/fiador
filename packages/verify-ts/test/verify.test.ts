import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalAttestationMessage,
  createVerifier,
  hashHumanId,
  toPublicVerifyResult,
} from '../src/index.js';
import { createStaticReader } from '../src/reader.js';
import type {
  AgentBookReader,
  EvmAddress,
  SignedAttestation,
  VerifyResult,
} from '../src/index.js';
import { buildVectors, type Vectors } from '../scripts/gen-fixtures.js';

const vectors: Vectors = JSON.parse(
  readFileSync(new URL('../fixtures/vectors.json', import.meta.url), 'utf8'),
);
const NOW = new Date(vectors.fixedNow);
const A = vectors.wallets.operatorA as EvmAddress;
const B = vectors.wallets.operatorB as EvmAddress;
const C = vectors.wallets.strangerC as EvmAddress;
const D = vectors.wallets.operatorD as EvmAddress;
const HUMAN_1 = vectors.humans.human1;
const HUMAN_2 = vectors.humans.human2;

function readerFromVectors(source: 'live' | 'fixture' = 'live'): AgentBookReader {
  const entries: Record<string, string | null> = {};
  for (const row of vectors.lookups) entries[row.address] = row.humanId;
  return createStaticReader(entries, source);
}

function verifier(overrides: Record<string, unknown> = {}) {
  return createVerifier({
    reader: readerFromVectors(),
    now: () => NOW,
    ...overrides,
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('fixture vectors', () => {
  it('committed vectors match a fresh deterministic generation', async () => {
    const fresh = await buildVectors();
    expect(fresh).toEqual(vectors);
  });
});

describe('browser-safe human hashing', () => {
  it('matches the original Node SHA-256 implementation byte-for-byte', () => {
    for (const value of ['', '0x1234', 'human-one', '世界 🌍']) {
      const expected = createHash('sha256').update(`w0-human-v1:${value}`, 'utf8').digest('hex');
      expect(hashHumanId(value)).toBe(expected);
    }
  });
});

describe('verifyAddress', () => {
  it('registered address -> verified with canonical hash and live evidence', async () => {
    const result = await verifier().verifyAddress(A);
    expect(result.status).toBe('verified');
    expect(result.failures).toEqual([]);
    expect(result.humanHash).toBe(hashHumanId(HUMAN_1));
    expect(result.evidence.source).toBe('live');
    expect(result.evidence.agentBook.contract).toBe(
      '0xA23aB2712eA7BBa896930544C7d6636a96b944dA',
    );
    expect(result.evidence.checkedAt).toBe(vectors.fixedNow);
    expect(result.addressTruncated).toBe(`${A.slice(0, 6)}…${A.slice(-5)}`);
  });

  it('two wallets of one human share a hash; a different human differs', async () => {
    const v = verifier();
    const ra = await v.verifyAddress(A);
    const rb = await v.verifyAddress(B);
    const rd = await v.verifyAddress(D);
    expect(rb.humanHash).toBe(ra.humanHash);
    expect(rd.humanHash).toBe(hashHumanId(HUMAN_2));
    expect(rd.humanHash).not.toBe(ra.humanHash);
  });

  it('unregistered wallet -> unregistered + not_registered', async () => {
    const result = await verifier().verifyAddress(C);
    expect(result.status).toBe('unregistered');
    expect(result.failures).toEqual(['not_registered']);
    expect(result.humanHash).toBeNull();
  });

  it('malformed addresses return invalid + malformed_address and never throw', async () => {
    const v = verifier();
    for (const bad of ['0x123', 'not-an-address', '', '0xZZZZ567890abcdef1234567890abcdef12345678']) {
      const result = await v.verifyAddress(bad);
      expect(result.status).toBe('invalid');
      expect(result.failures).toEqual(['malformed_address']);
    }
  });

  it('lowercase input is accepted and output is checksummed', async () => {
    const result = await verifier().verifyAddress(A.toLowerCase());
    expect(result.status).toBe('verified');
    expect(result.address).toBe(A);
  });
});

describe('lookup failure separation (the SDK regression test)', () => {
  const throwing: AgentBookReader = {
    source: 'live',
    async lookupHuman() {
      throw new Error('RPC endpoint unreachable');
    },
  };

  it('reader throw -> unknown + lookup_failed, explicitly not unregistered', async () => {
    const result = await verifier({ reader: throwing }).verifyAddress(A);
    expect(result.status).toBe('unknown');
    expect(result.status).not.toBe('unregistered');
    expect(result.failures).toEqual(['lookup_failed']);
  });

  it('reader that never resolves + deadline -> unknown + lookup_timeout', async () => {
    const hanging: AgentBookReader = {
      source: 'live',
      lookupHuman: () => new Promise<string | null>(() => {}),
    };
    const result = await verifier({ reader: hanging, timeoutMs: 40 }).verifyAddress(A);
    expect(result.status).toBe('unknown');
    expect(result.failures).toEqual(['lookup_timeout']);
  });

  it('caller abort -> unknown + lookup_failed', async () => {
    const slow: AgentBookReader = {
      source: 'live',
      lookupHuman: () =>
        new Promise<string | null>((resolve) => setTimeout(() => resolve(HUMAN_1), 200)),
    };
    const controller = new AbortController();
    const v = verifier({ reader: slow, timeoutMs: 5000 });
    const pending = v.verifyAddress(A, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const result = await pending;
    expect(result.status).toBe('unknown');
    expect(result.failures).toEqual(['lookup_failed']);
  });
});

describe('verifyAttestation', () => {
  it('valid attestation from a registered wallet -> verified', async () => {
    const att = vectors.attestations.valid as SignedAttestation;
    const result = await verifier().verifyAttestation(att, {
      expectedSubject: att.payload.subject,
    });
    expect(result.status).toBe('verified');
    expect(result.failures).toEqual([]);
    expect(result.humanHash).toBe(hashHumanId(HUMAN_1));
  });

  it('checkRegistration: false verifies on signature and dates alone', async () => {
    const att = clone(vectors.attestations.valid) as SignedAttestation;
    att.payload.agentWalletAddress = C; // unregistered wallet
    // Re-signing is required for the wallet change to be authentic; use
    // the wrongSigner vector instead: valid signature by C over a
    // payload naming A would mismatch. So: verify the stranger-signed
    // claim is invalid, then verify `valid` with registration off from
    // a reader that would fail — proving no lookup happens.
    const failingReader: AgentBookReader = {
      source: 'live',
      async lookupHuman() {
        throw new Error('must not be called');
      },
    };
    const result = await verifier({ reader: failingReader }).verifyAttestation(
      vectors.attestations.valid,
      { checkRegistration: false },
    );
    expect(result.status).toBe('verified');
    expect(result.humanHash).toBeNull();
  });

  it('valid signature from an unregistered wallet does not rescue it', async () => {
    // strangerC signs its own payload: signature valid, wallet unregistered.
    const att = clone(vectors.attestations.valid) as SignedAttestation;
    att.payload.agentWalletAddress = C;
    // Signature no longer matches the mutated payload, so this also
    // exercises mismatch; the dedicated unregistered case is below via
    // a reader that reports null for A.
    const nullReader = createStaticReader({ [A]: null }, 'live');
    const result = await verifier({ reader: nullReader }).verifyAttestation(
      vectors.attestations.valid,
    );
    expect(result.status).toBe('unregistered');
    expect(result.failures).toEqual(['not_registered']);
    void att;
  });

  it('expired attestation -> expired; expired outranks a failing lookup', async () => {
    const throwing: AgentBookReader = {
      source: 'live',
      async lookupHuman() {
        throw new Error('down');
      },
    };
    const result = await verifier({ reader: throwing }).verifyAttestation(
      vectors.attestations.expired,
    );
    expect(result.status).toBe('expired');
    expect(result.failures).toContain('expired');
  });

  it('issuedAt beyond skew in the future -> invalid + not_yet_valid', async () => {
    const result = await verifier().verifyAttestation(vectors.attestations.notYetValid);
    expect(result.status).toBe('invalid');
    expect(result.failures).toContain('not_yet_valid');
  });

  it('lifetime over 90 days -> invalid + malformed_attestation', async () => {
    const result = await verifier().verifyAttestation(vectors.attestations.longLifetime);
    expect(result.status).toBe('invalid');
    expect(result.failures).toContain('malformed_attestation');
  });

  it('wrong signer -> invalid + signature_mismatch', async () => {
    const result = await verifier().verifyAttestation(vectors.attestations.wrongSigner);
    expect(result.status).toBe('invalid');
    expect(result.failures).toContain('signature_mismatch');
  });

  it('tampering with any signed field -> signature_mismatch', async () => {
    const v = verifier();
    const mutations: Array<[string, (a: SignedAttestation) => void]> = [
      ['subject id', (a) => (a.payload.subject.id = '999999999999999999')],
      ['wallet', (a) => (a.payload.agentWalletAddress = B)],
      [
        'expiresAt',
        (a) => (a.payload.expiresAt = new Date(Date.parse(a.payload.expiresAt) + 86_400_000).toISOString()),
      ],
      ['nonce', (a) => (a.payload.nonce = 'ff'.repeat(32))],
      ['extra field', (a) => (a.payload.extra = { discord_bot_user_id: '333333333333333333' })],
      ['disclosure', (a) => (a.payload.humanIdDisclosure = 'none')],
    ];
    for (const [name, mutate] of mutations) {
      const att = clone(vectors.attestations.valid) as SignedAttestation;
      mutate(att);
      const result = await v.verifyAttestation(att, { checkRegistration: false });
      expect(result.status, name).toBe('invalid');
      expect(result.failures, name).toContain('signature_mismatch');
    }
  });

  it('wrong expected subject -> subject_mismatch (the cross-bot replay case)', async () => {
    const result = await verifier().verifyAttestation(vectors.attestations.valid, {
      expectedSubject: { type: 'discord_application', id: '444444444444444444' },
    });
    expect(result.status).toBe('invalid');
    expect(result.failures).toContain('subject_mismatch');
  });

  it('wrong expected wallet -> wallet_mismatch', async () => {
    const result = await verifier().verifyAttestation(vectors.attestations.valid, {
      expectedWallet: B,
    });
    expect(result.status).toBe('invalid');
    expect(result.failures).toContain('wallet_mismatch');
  });

  it('replay: second presentation with a nonce store -> replay_detected; other wallet unaffected', async () => {
    const records = new Map<string, string>();
    const store = {
      async has(nonce: string, wallet: EvmAddress) {
        const exp = records.get(`${wallet}:${nonce}`);
        return exp !== undefined && Date.parse(exp) > NOW.getTime();
      },
      async add(nonce: string, wallet: EvmAddress, expiresAt: string) {
        records.set(`${wallet}:${nonce}`, expiresAt);
      },
    };
    const v = verifier();
    const first = await v.verifyAttestation(vectors.attestations.valid, { nonceStore: store });
    expect(first.status).toBe('verified');
    const second = await v.verifyAttestation(vectors.attestations.valid, { nonceStore: store });
    expect(second.status).toBe('invalid');
    expect(second.failures).toContain('replay_detected');
    // Same nonce under a different wallet is not a replay: B is
    // registered to the same human; present A's attestation expecting
    // B and the failure must be binding/signature, not replay.
    const other = await v.verifyAttestation(vectors.attestations.valid, {
      nonceStore: store,
      expectedWallet: B,
    });
    expect(other.failures).not.toContain('replay_detected');
  });

  it('malformed attestations return results and never throw', async () => {
    const v = verifier();
    const cases: Array<[unknown, string]> = [
      [null, 'malformed_attestation'],
      ['a string', 'malformed_attestation'],
      [{}, 'malformed_attestation'],
      [
        { ...clone(vectors.attestations.valid), payload: { ...clone(vectors.attestations.valid).payload, version: 2 } },
        'unsupported_version',
      ],
      [
        { ...clone(vectors.attestations.valid), payload: { ...clone(vectors.attestations.valid).payload, nonce: 'short' } },
        'malformed_attestation',
      ],
    ];
    for (const [input, code] of cases) {
      const result = await v.verifyAttestation(input);
      expect(result.status).toBe('invalid');
      expect(result.failures).toContain(code);
    }
  });

  it('attestation racing expiry: now injected past expiry mid-flow -> expired', async () => {
    // Reader would return a registration, but the attestation is
    // evaluated against the injected clock: move now past expiresAt.
    const later = new Date(Date.parse(vectors.attestations.valid.payload.expiresAt) + 1000);
    const result = await verifier({ now: () => later }).verifyAttestation(
      vectors.attestations.valid,
    );
    expect(result.status).toBe('expired');
  });
});

describe('ERC-1271 smart-wallet attestation', () => {
  it('verifies through the contract path against a stubbed RPC', async () => {
    const contractWallet = '0x00000000000000000000000000000000C0FFEE01' as EvmAddress;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { method: string; id: number };
        if (parsed.method === 'eth_call') {
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              result: `0x1626ba7e${'00'.repeat(28)}`,
            }),
          );
        } else {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: '0x1e0' }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    try {
      const att = clone(vectors.attestations.valid) as SignedAttestation;
      att.payload.agentWalletAddress = contractWallet;
      att.signatureType = 'eip1271';
      att.signature = `0x${'11'.repeat(65)}`;
      const v = createVerifier({
        reader: createStaticReader({ [contractWallet]: HUMAN_1 }, 'live'),
        rpcUrl: `http://127.0.0.1:${address.port}`,
        now: () => NOW,
      });
      const result = await v.verifyAttestation(att);
      expect(result.status).toBe('verified');
      expect(result.humanHash).toBe(hashHumanId(HUMAN_1));
    } finally {
      server.close();
    }
  });
});

describe('World Chain RPC identity', () => {
  async function withRpc(chainId: string, check: (url: string, calls: () => number) => Promise<void>) {
    let ethCalls = 0;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { method: string; id: number };
        if (parsed.method === 'eth_call') ethCalls += 1;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          result: parsed.method === 'eth_chainId'
            ? chainId
            : `0x${'0'.repeat(63)}1`, // a positive AgentBook lookup
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    try {
      await check(`http://127.0.0.1:${address.port}`, () => ethCalls);
    } finally {
      server.close();
    }
  }

  it('accepts a positive AgentBook lookup only after eth_chainId confirms 480', async () => {
    await withRpc('0x1e0', async (rpcUrl, calls) => {
      const result = await createVerifier({ rpcUrl }).verifyAddress(A);
      expect(result.status).toBe('verified');
      expect(result.humanHash).toBe(hashHumanId('0x1'));
      expect(calls()).toBe(1);
    });
  });

  it('treats a positive lookup offered by chain 1 as unknown, before eth_call', async () => {
    await withRpc('0x1', async (rpcUrl, calls) => {
      const result = await createVerifier({ rpcUrl }).verifyAddress(A);
      expect(result.status).toBe('unknown');
      expect(result.failures).toEqual(['lookup_failed']);
      expect(result.humanHash).toBeNull();
      expect(calls()).toBe(0);
    });
  });

  it('treats an ERC-1271 signature on chain 1 as unknown, before eth_call', async () => {
    await withRpc('0x1', async (rpcUrl, calls) => {
      const contractWallet = '0x00000000000000000000000000000000C0FFEE01' as EvmAddress;
      const att = clone(vectors.attestations.valid) as SignedAttestation;
      att.payload.agentWalletAddress = contractWallet;
      att.signatureType = 'eip1271';
      att.signature = `0x${'11'.repeat(65)}`;
      const v = createVerifier({
        reader: createStaticReader({ [contractWallet]: HUMAN_1 }, 'live'),
        rpcUrl,
        now: () => NOW,
      });
      const result = await v.verifyAttestation(att);
      expect(result.status).toBe('unknown');
      expect(result.failures).toEqual(['lookup_failed']);
      expect(result.humanHash).toBeNull();
      expect(calls()).toBe(0);
    });
  });
});

describe('raw humanId discipline (security property)', () => {
  it('default results contain no humanId field and no raw value', async () => {
    const result = await verifier().verifyAddress(A);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(HUMAN_1);
    expect(serialised).not.toContain('"humanId"');
    expect('humanId' in result).toBe(false);
  });

  it('includeRawHumanId carries the value internally and still hashes', async () => {
    const result = await verifier({ includeRawHumanId: true }).verifyAddress(A);
    expect(result.humanId).toBe(HUMAN_1);
    expect(result.humanHash).toBe(hashHumanId(HUMAN_1));
  });

  it('projection is a fresh object: deep scan finds no raw value, no key, no full address', async () => {
    const internal: VerifyResult = await verifier({ includeRawHumanId: true }).verifyAddress(A);
    const pub = toPublicVerifyResult(internal);
    const serialised = JSON.stringify(pub);
    expect(serialised).not.toContain(HUMAN_1);
    expect(serialised).not.toContain('"humanId"');
    expect(serialised).not.toContain(A);
    expect(Object.keys(pub).sort()).toEqual(
      ['addressTruncated', 'evidence', 'failures', 'humanHash', 'status'].sort(),
    );
    // A field added to the internal object afterwards cannot leak
    // through the already-minted projection, and a fresh projection
    // still contains only the public keys.
    (internal as unknown as Record<string, unknown>).futureInternalField = 'leak-me';
    const pub2 = toPublicVerifyResult(internal);
    expect(JSON.stringify(pub2)).not.toContain('leak-me');
    expect(JSON.stringify(pub2)).not.toContain('futureInternalField');
  });

  it("disclosure 'none' omits the hash from the public shape only", async () => {
    const v = verifier();
    const internal = await v.verifyAttestation(vectors.attestations.validDisclosureNone);
    expect(internal.status).toBe('verified');
    expect(internal.humanHash).toBe(hashHumanId(HUMAN_1));
    const pub = toPublicVerifyResult(internal);
    expect(pub.humanHash).toBeNull();
    const pubDefault = toPublicVerifyResult(await v.verifyAttestation(vectors.attestations.valid));
    expect(pubDefault.humanHash).toBe(hashHumanId(HUMAN_1));
  });
});

describe('resolveStatus', () => {
  it('address subject delegates to verifyAddress', async () => {
    const result = await verifier().resolveStatus({ kind: 'address', address: A });
    expect(result.status).toBe('verified');
  });

  it('attested_subject resolves and verifies with binding', async () => {
    const att = vectors.attestations.valid as SignedAttestation;
    const result = await verifier().resolveStatus({
      kind: 'attested_subject',
      subject: att.payload.subject,
      resolveAttestation: async () => att,
    });
    expect(result.status).toBe('verified');
  });

  it('resolver returning null -> unknown + attestation_not_found', async () => {
    const result = await verifier().resolveStatus({
      kind: 'attested_subject',
      subject: { type: 'discord_application', id: '555555555555555555' },
      resolveAttestation: async () => null,
    });
    expect(result.status).toBe('unknown');
    expect(result.failures).toEqual(['attestation_not_found']);
  });

  it('resolver throwing -> unknown + lookup_failed', async () => {
    const result = await verifier().resolveStatus({
      kind: 'attested_subject',
      subject: { type: 'discord_application', id: '555555555555555555' },
      resolveAttestation: async () => {
        throw new Error('registry unreachable');
      },
    });
    expect(result.status).toBe('unknown');
    expect(result.failures).toEqual(['lookup_failed']);
  });
});

describe('canonical form', () => {
  it('keys are in protocol order and extra keys are sorted', () => {
    const att = clone(vectors.attestations.valid) as SignedAttestation;
    att.payload.extra = { zebra: '2', alpha: '1' };
    const message = canonicalAttestationMessage(att.payload);
    expect(message.startsWith('{"version":1,"subject":{"type":"discord_application"')).toBe(true);
    expect(message).toContain('"extra":{"alpha":"1","zebra":"2"}');
    // No insignificant (structural) whitespace: separators are bare.
    expect(message).not.toContain('": "');
    expect(message).not.toContain(', "');
  });
});

describe('verifySignedMessage (SPEC 3.6 amendment, D5)', () => {
  const SM = vectors.signedMessages.operatorA;
  const CONTRACT = '0x00000000000000000000000000000000C0FFEE01' as EvmAddress;

  // verifySignedMessage performs no AgentBook lookup: build its
  // verifiers on a reader that throws if it is ever called.
  const throwingReader: AgentBookReader = {
    source: 'live',
    async lookupHuman() {
      throw new Error('verifySignedMessage must not call the AgentBook reader');
    },
  };
  function noLookupVerifier(overrides: Record<string, unknown> = {}) {
    return createVerifier({ reader: throwingReader, now: () => NOW, ...overrides });
  }

  async function with1271Rpc(
    ethCallResult: string,
    check: (rpcUrl: string, ethCalls: () => number) => Promise<void>,
    chainId = '0x1e0',
  ) {
    let ethCalls = 0;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { method: string; id: number };
        if (parsed.method === 'eth_call') ethCalls += 1;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: parsed.method === 'eth_call' ? ethCallResult : chainId,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    try {
      await check(`http://127.0.0.1:${address.port}`, () => ethCalls);
    } finally {
      server.close();
    }
  }

  it('fixture sanity: the signed-message vector belongs to operatorA', () => {
    expect(SM.signer).toBe(A);
  });

  it('EOA: valid signature verifies and returns the checksummed signer, with no lookup and no human identifier', async () => {
    const result = await noLookupVerifier().verifySignedMessage({
      message: SM.message,
      signature: SM.signature,
      signatureType: 'eoa',
    });
    expect(result.verified).toBe(true);
    expect(result.address).toBe(A);
    expect(result.failures).toEqual([]);
    // The result is exactly the amendment's small shape; no humanId
    // or humanHash in either direction.
    expect(Object.keys(result).sort()).toEqual(['address', 'failures', 'verified']);
    expect(JSON.stringify(result)).not.toContain(HUMAN_1);
  });

  it('EOA: expectedAddress match verifies (case-insensitive input, checksummed output)', async () => {
    const result = await noLookupVerifier().verifySignedMessage({
      message: SM.message,
      signature: SM.signature,
      signatureType: 'eoa',
      expectedAddress: A.toLowerCase(),
    });
    expect(result.verified).toBe(true);
    expect(result.address).toBe(A);
    expect(result.failures).toEqual([]);
  });

  it('EOA: expectedAddress mismatch -> subject_mismatch, recovered signer still reported', async () => {
    const result = await noLookupVerifier().verifySignedMessage({
      message: SM.message,
      signature: SM.signature,
      signatureType: 'eoa',
      expectedAddress: B,
    });
    expect(result.verified).toBe(false);
    expect(result.failures).toEqual(['subject_mismatch']);
    expect(result.address).toBe(A);
  });

  it('EOA: tampered message no longer matches the expected signer -> subject_mismatch', async () => {
    // A tampered message still recovers, to a different signer; the
    // amendment assigns that event to the expected-address code, and
    // an undecodable signature (next test) to signature_mismatch.
    const result = await noLookupVerifier().verifySignedMessage({
      message: `${SM.message} (tampered)`,
      signature: SM.signature,
      signatureType: 'eoa',
      expectedAddress: A,
    });
    expect(result.verified).toBe(false);
    expect(result.failures).toEqual(['subject_mismatch']);
    expect(result.address).not.toBeNull();
    expect(result.address).not.toBe(A);
  });

  it('EOA: undecodable signatures -> signature_mismatch, no signer, never throws', async () => {
    const v = noLookupVerifier();
    const badSignatures = [
      SM.signature.slice(0, 82), // truncated: invalid length
      '0xbeef', // well-formed hex, not a signature
      'not-a-signature', // not hex at all
    ];
    for (const signature of badSignatures) {
      const result = await v.verifySignedMessage({
        message: SM.message,
        signature,
        signatureType: 'eoa',
        expectedAddress: A,
      });
      expect(result.verified).toBe(false);
      expect(result.failures).toEqual(['signature_mismatch']);
      expect(result.address).toBeNull();
    }
  });

  it('malformed expectedAddress -> malformed_address, never throws', async () => {
    const v = noLookupVerifier();
    for (const expectedAddress of ['0x123', 'not-an-address', '']) {
      const result = await v.verifySignedMessage({
        message: SM.message,
        signature: SM.signature,
        signatureType: 'eoa',
        expectedAddress,
      });
      expect(result.verified).toBe(false);
      expect(result.failures).toEqual(['malformed_address']);
      expect(result.address).toBeNull();
    }
  });

  it('unrecognised signatureType is rejected without throwing', async () => {
    const result = await noLookupVerifier().verifySignedMessage({
      message: SM.message,
      signature: SM.signature,
      signatureType: 'eip712' as unknown as 'eoa',
      expectedAddress: A,
    });
    expect(result.verified).toBe(false);
    expect(result.failures).toEqual(['signature_mismatch']);
    expect(result.address).toBeNull();
  });

  it('ERC-1271: magic value from the named contract verifies', async () => {
    await with1271Rpc(`0x1626ba7e${'00'.repeat(28)}`, async (rpcUrl, ethCalls) => {
      const result = await noLookupVerifier({ rpcUrl }).verifySignedMessage({
        message: SM.message,
        signature: `0x${'11'.repeat(65)}`,
        signatureType: 'erc1271',
        expectedAddress: CONTRACT,
      });
      expect(result.verified).toBe(true);
      expect(result.address).toBe(CONTRACT);
      expect(result.failures).toEqual([]);
      expect(ethCalls()).toBeGreaterThan(0);
    });
  });

  it('ERC-1271: non-magic result -> signature_mismatch', async () => {
    await with1271Rpc(`0x${'00'.repeat(32)}`, async (rpcUrl) => {
      const result = await noLookupVerifier({ rpcUrl }).verifySignedMessage({
        message: SM.message,
        signature: `0x${'11'.repeat(65)}`,
        signatureType: 'erc1271',
        expectedAddress: CONTRACT,
      });
      expect(result.verified).toBe(false);
      expect(result.failures).toEqual(['signature_mismatch']);
      expect(result.address).toBe(CONTRACT);
    });
  });

  it('ERC-1271: wrong-chain RPC -> lookup_failed (check unexecutable, not a mismatch)', async () => {
    // SPEC 3.6 D5 amendment, pinned Oct 26, 2026 (world-program
    // cba7539): an ERC-1271 check that cannot be executed at all is
    // unchecked (lookup_failed), never signature_mismatch. The stub
    // answers eth_chainId with chain 1 while standing ready to
    // return the magic value on eth_call; the ethCalls assertion
    // proves the check itself never ran.
    await with1271Rpc(
      `0x1626ba7e${'00'.repeat(28)}`,
      async (rpcUrl, ethCalls) => {
        const result = await noLookupVerifier({ rpcUrl }).verifySignedMessage({
          message: SM.message,
          signature: `0x${'11'.repeat(65)}`,
          signatureType: 'erc1271',
          expectedAddress: CONTRACT,
        });
        expect(result.verified).toBe(false);
        expect(result.failures).toEqual(['lookup_failed']);
        expect(result.address).toBe(CONTRACT);
        expect(ethCalls()).toBe(0);
      },
      '0x1',
    );
  });

  it('ERC-1271: missing expectedAddress -> signature_mismatch, no signer named', async () => {
    const result = await noLookupVerifier().verifySignedMessage({
      message: SM.message,
      signature: `0x${'11'.repeat(65)}`,
      signatureType: 'erc1271',
    });
    expect(result.verified).toBe(false);
    expect(result.failures).toEqual(['signature_mismatch']);
    expect(result.address).toBeNull();
  });

  it("EOA path against a contract address fails and never falls through to ERC-1271", async () => {
    // The stub would answer the magic value if the EOA path silently
    // switched paths; the assertion on ethCalls proves it does not.
    await with1271Rpc(`0x1626ba7e${'00'.repeat(28)}`, async (rpcUrl, ethCalls) => {
      const result = await noLookupVerifier({ rpcUrl }).verifySignedMessage({
        message: SM.message,
        signature: `0x${'11'.repeat(65)}`,
        signatureType: 'eoa',
        expectedAddress: CONTRACT,
      });
      expect(result.verified).toBe(false);
      expect(result.failures).toEqual(['signature_mismatch']);
      expect(result.address).toBeNull();
      expect(ethCalls()).toBe(0);
    });
  });
});
