import { describe, expect, it, vi } from 'vitest';
import {
  createVerifier,
  hashHumanId,
  toPublicVerifyResult,
  type AgentBookReader,
  type AttestationPayloadV1,
  type EvmAddress,
  type NonceStore,
  type SignatureVerifier,
  type SignedAttestation,
} from './index.js';

// SYNTHETIC FIXTURE ONLY: this is not a real humanId. It is a made-up value
// with the right shape (0x + 64 hex chars), used so tests can prove the raw
// value never reaches a public result. Never replace it with a real one.
const SYNTHETIC_HUMAN_ID = '0x' + '11'.repeat(32);

const WALLET = ('0x' + 'ab'.repeat(20)) as EvmAddress;
const FIXED_NOW = new Date('2026-10-26T12:00:00.000Z');
const GOOD_SIGNATURE = '0xfake-valid-signature';

const fixedClock = () => new Date(FIXED_NOW);

function readerReturning(value: string | null): AgentBookReader {
  return { lookupHuman: async () => value };
}

const registeredReader = readerReturning(SYNTHETIC_HUMAN_ID);
const unregisteredReader = readerReturning(null);
const throwingReader: AgentBookReader = {
  lookupHuman: async () => {
    throw new Error('RPC unreachable');
  },
};

const goodSignatureVerifier: SignatureVerifier = {
  verifySignature: async (attestation) => attestation.signature === GOOD_SIGNATURE,
};

function makePayload(
  overrides: Partial<AttestationPayloadV1> = {},
): AttestationPayloadV1 {
  return {
    version: 1,
    subject: { type: 'discord_application', id: '123456789012345678' },
    agentWalletAddress: WALLET,
    humanIdDisclosure: 'hash',
    issuedAt: '2026-10-20T12:00:00.000Z',
    expiresAt: '2026-11-19T12:00:00.000Z', // 30 days: inside the 90-day cap
    nonce: 'cd'.repeat(16),
    ...overrides,
  };
}

function makeAttestation(
  overrides: Partial<AttestationPayloadV1> = {},
  signature: string = GOOD_SIGNATURE,
): SignedAttestation {
  return { payload: makePayload(overrides), signature, signatureType: 'eip191' };
}

function makeVerifier(
  reader: AgentBookReader,
  extra: Parameters<typeof createVerifier>[0] = {},
) {
  return createVerifier({
    reader,
    signatureVerifier: goodSignatureVerifier,
    now: fixedClock,
    source: 'fixture',
    ...extra,
  });
}

describe('verifyAddress', () => {
  it('verified: registered wallet yields the human hash, no raw id by default', async () => {
    const verifier = makeVerifier(registeredReader);
    const result = await verifier.verifyAddress(WALLET);
    expect(result.status).toBe('verified');
    expect(result.failures).toEqual([]);
    expect(result.humanHash).toBe(hashHumanId(SYNTHETIC_HUMAN_ID));
    expect(result.humanId).toBeUndefined();
    expect(result.addressTruncated).toBe('0xabab…babab');
  });

  it('accepts any address casing and normalises the output address', async () => {
    const verifier = makeVerifier(registeredReader);
    const result = await verifier.verifyAddress('0x' + 'AB'.repeat(20));
    expect(result.status).toBe('verified');
    expect(result.address).toBe(WALLET);
  });

  it('carries the raw humanId internally only when includeRawHumanId is set', async () => {
    const verifier = makeVerifier(registeredReader, { includeRawHumanId: true });
    const result = await verifier.verifyAddress(WALLET);
    expect(result.status).toBe('verified');
    expect(result.humanId).toBe(SYNTHETIC_HUMAN_ID);
  });

  it('unregistered: a resolved null is unregistered + not_registered', async () => {
    const verifier = makeVerifier(unregisteredReader);
    const result = await verifier.verifyAddress(WALLET);
    expect(result.status).toBe('unregistered');
    expect(result.failures).toEqual(['not_registered']);
    expect(result.humanHash).toBeNull();
  });

  it('unknown: a throwing reader is unknown + lookup_failed, never unregistered', async () => {
    const verifier = makeVerifier(throwingReader);
    const result = await verifier.verifyAddress(WALLET);
    expect(result.status).toBe('unknown');
    expect(result.failures).toEqual(['lookup_failed']);
  });

  it('unknown: a lookup past the deadline is lookup_timeout', async () => {
    const slowReader: AgentBookReader = {
      lookupHuman: () =>
        new Promise((resolve) => setTimeout(() => resolve(SYNTHETIC_HUMAN_ID), 100)),
    };
    const verifier = makeVerifier(slowReader, { timeoutMs: 10 });
    const result = await verifier.verifyAddress(WALLET);
    expect(result.status).toBe('unknown');
    expect(result.failures).toEqual(['lookup_timeout']);
  });

  it('malformed: a bad address is invalid and never touches the reader', async () => {
    const lookupHuman = vi.fn(async () => SYNTHETIC_HUMAN_ID);
    const verifier = makeVerifier({ lookupHuman });
    const result = await verifier.verifyAddress('not-an-address');
    expect(result.status).toBe('invalid');
    expect(result.failures).toEqual(['malformed_address']);
    expect(lookupHuman).not.toHaveBeenCalled();
  });

  it('unknown: a verifier built without a reader fails closed', async () => {
    const verifier = createVerifier({ now: fixedClock, source: 'fixture' });
    const result = await verifier.verifyAddress(WALLET);
    expect(result.status).toBe('unknown');
    expect(result.failures).toEqual(['lookup_failed']);
  });
});

describe('verifyAttestation', () => {
  it("happy path: verified, and disclosure 'hash' keeps the hash in the public result", async () => {
    const verifier = makeVerifier(registeredReader);
    const result = await verifier.verifyAttestation(makeAttestation());
    expect(result.status).toBe('verified');
    expect(result.failures).toEqual([]);
    expect(result.humanHash).toBe(hashHumanId(SYNTHETIC_HUMAN_ID));

    const publicResult = toPublicVerifyResult(result);
    expect(publicResult.status).toBe('verified');
    expect(publicResult.humanHash).toBe(hashHumanId(SYNTHETIC_HUMAN_ID));
  });

  it("disclosure 'none': still verified, but the public result drops the hash", async () => {
    const verifier = makeVerifier(registeredReader);
    const result = await verifier.verifyAttestation(
      makeAttestation({ humanIdDisclosure: 'none' }),
    );
    expect(result.status).toBe('verified');
    expect(toPublicVerifyResult(result).humanHash).toBeNull();
  });

  it('rejects a payload carrying a raw humanId field as malformed', async () => {
    const verifier = makeVerifier(registeredReader);
    const poisoned = makeAttestation() as unknown as Record<string, unknown>;
    (poisoned.payload as Record<string, unknown>).humanId = SYNTHETIC_HUMAN_ID;
    const result = await verifier.verifyAttestation(poisoned);
    expect(result.status).toBe('invalid');
    expect(result.failures).toEqual(['malformed_attestation']);
    // The raw value is never echoed back in the result.
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_HUMAN_ID);
  });

  it("rejects humanIdDisclosure 'raw' as malformed", async () => {
    const verifier = makeVerifier(registeredReader);
    const attestation = makeAttestation() as unknown as Record<string, unknown>;
    (attestation.payload as Record<string, unknown>).humanIdDisclosure = 'raw';
    const result = await verifier.verifyAttestation(attestation);
    expect(result.status).toBe('invalid');
    expect(result.failures).toEqual(['malformed_attestation']);
  });

  it('expired: a past expiresAt is expired even when registered and well-signed', async () => {
    const verifier = makeVerifier(registeredReader);
    const result = await verifier.verifyAttestation(
      makeAttestation({
        issuedAt: '2026-10-01T12:00:00.000Z',
        expiresAt: '2026-10-25T12:00:00.000Z',
      }),
    );
    expect(result.status).toBe('expired');
    expect(result.failures).toContain('expired');
    expect(result.humanHash).toBeNull();
  });

  it('not_yet_valid: an issuedAt beyond the clock skew is invalid', async () => {
    const verifier = makeVerifier(registeredReader);
    const result = await verifier.verifyAttestation(
      makeAttestation({
        issuedAt: '2026-10-27T12:00:00.000Z',
        expiresAt: '2026-11-26T12:00:00.000Z',
      }),
    );
    expect(result.status).toBe('invalid');
    expect(result.failures).toContain('not_yet_valid');
  });

  it('subject_mismatch: an attestation for another subject is invalid', async () => {
    const verifier = makeVerifier(registeredReader);
    const result = await verifier.verifyAttestation(makeAttestation(), {
      expectedSubject: { type: 'discord_application', id: '999999999999999999' },
    });
    expect(result.status).toBe('invalid');
    expect(result.failures).toContain('subject_mismatch');
  });

  it('signature_mismatch: the default stub verifier verifies nothing', async () => {
    const verifier = createVerifier({
      reader: registeredReader,
      now: fixedClock,
      source: 'fixture',
      // no signatureVerifier: the stub is installed by default
    });
    const result = await verifier.verifyAttestation(makeAttestation());
    expect(result.status).toBe('invalid');
    expect(result.failures).toContain('signature_mismatch');
  });

  it('not_registered: a good signature from an unregistered wallet attests nothing', async () => {
    const verifier = makeVerifier(unregisteredReader);
    const result = await verifier.verifyAttestation(makeAttestation());
    expect(result.status).toBe('unregistered');
    expect(result.failures).toEqual(['not_registered']);
    expect(result.humanHash).toBeNull();
  });

  it('replay_detected: a nonce already in the store is invalid', async () => {
    const store: NonceStore = { has: async () => true, add: async () => {} };
    const verifier = makeVerifier(registeredReader);
    const result = await verifier.verifyAttestation(makeAttestation(), {
      nonceStore: store,
    });
    expect(result.status).toBe('invalid');
    expect(result.failures).toContain('replay_detected');
  });

  it('records the nonce in the store on full success', async () => {
    const added: string[] = [];
    const store: NonceStore = {
      has: async () => false,
      add: async (nonce) => {
        added.push(nonce);
      },
    };
    const verifier = makeVerifier(registeredReader);
    const attestation = makeAttestation();
    const result = await verifier.verifyAttestation(attestation, { nonceStore: store });
    expect(result.status).toBe('verified');
    expect(added).toEqual([attestation.payload.nonce]);
  });

  it('unsupported_version: a version other than 1 is rejected distinctly', async () => {
    const verifier = makeVerifier(registeredReader);
    const attestation = makeAttestation() as unknown as Record<string, unknown>;
    (attestation.payload as Record<string, unknown>).version = 2;
    const result = await verifier.verifyAttestation(attestation);
    expect(result.status).toBe('invalid');
    expect(result.failures).toEqual(['unsupported_version']);
  });
});

describe('resolveStatus', () => {
  it('attested_subject with a null resolver is unknown + attestation_not_found', async () => {
    const verifier = makeVerifier(registeredReader);
    const result = await verifier.resolveStatus({
      kind: 'attested_subject',
      subject: { type: 'discord_application', id: '123456789012345678' },
      resolveAttestation: async () => null,
    });
    expect(result.status).toBe('unknown');
    expect(result.failures).toEqual(['attestation_not_found']);
  });

  it('attested_subject verifies the resolved attestation against the subject', async () => {
    const verifier = makeVerifier(registeredReader);
    const attestation = makeAttestation();
    const result = await verifier.resolveStatus({
      kind: 'attested_subject',
      subject: attestation.payload.subject,
      resolveAttestation: async () => attestation,
    });
    expect(result.status).toBe('verified');
  });

  it("kind 'address' delegates to verifyAddress", async () => {
    const verifier = makeVerifier(unregisteredReader);
    const result = await verifier.resolveStatus({ kind: 'address', address: WALLET });
    expect(result.status).toBe('unregistered');
  });
});

describe('toPublicVerifyResult boundary', () => {
  it('deep scan: the public JSON carries neither the raw humanId nor a humanId key', async () => {
    const verifier = makeVerifier(registeredReader, { includeRawHumanId: true });
    const internal = await verifier.verifyAttestation(makeAttestation());
    // The internal result really does hold the raw value, so the scan means something.
    expect(internal.status).toBe('verified');
    expect(internal.humanId).toBe(SYNTHETIC_HUMAN_ID);

    const serialised = JSON.stringify(toPublicVerifyResult(internal));
    expect(serialised).not.toContain(SYNTHETIC_HUMAN_ID);
    expect(serialised).not.toContain('"humanId"');
    expect(serialised).toContain('"humanHash"');
  });
});
