// Deterministic fixture generator (SPEC 7.1). Every wallet, humanId,
// subject, and signature in fixtures/vectors.json is SYNTHETIC:
// wallets derive from labelled seed strings hashed at generation time
// (no real or known key material appears in this repo), humanIds are
// invented constants in the correct format, and the vectors store
// payload + signature + expected outcomes so any implementation
// (including a future Python port) can prove parity against the same
// files. CI asserts the committed vectors match a fresh generation.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { canonicalAttestationMessage } from '../src/canonical.js';
import type { AttestationPayloadV1, SignedAttestation } from '../src/types.js';

export const FIXED_NOW_ISO = '2026-01-15T12:00:00.000Z';
const NOW_MS = Date.parse(FIXED_NOW_ISO);
const DAY_MS = 24 * 60 * 60 * 1000;

function syntheticAccount(index: number) {
  const key = keccak256(toBytes(`fiador-verify-ts-synthetic-key-${index}`));
  return privateKeyToAccount(key);
}

export const HUMAN_1 = `0x${'a1'.repeat(32)}`;
export const HUMAN_2 = `0x${'b2'.repeat(32)}`;

function payload(
  wallet: `0x${string}`,
  overrides: Partial<AttestationPayloadV1> = {},
): AttestationPayloadV1 {
  return {
    version: 1,
    subject: { type: 'discord_application', id: '111111111111111111' },
    agentWalletAddress: wallet,
    attestationUrl: 'https://example.invalid/attestations/operator-a.json',
    operatorDisplayName: 'Synthetic Operator A',
    humanIdDisclosure: 'hash',
    issuedAt: new Date(NOW_MS - DAY_MS).toISOString(),
    expiresAt: new Date(NOW_MS + 30 * DAY_MS).toISOString(),
    nonce: 'cd'.repeat(32),
    extra: { discord_bot_user_id: '222222222222222222' },
    ...overrides,
  };
}

async function sign(
  account: ReturnType<typeof syntheticAccount>,
  p: AttestationPayloadV1,
): Promise<SignedAttestation> {
  const signature = await account.signMessage({
    message: canonicalAttestationMessage(p),
  });
  return { payload: p, signature, signatureType: 'eip191' };
}

export async function buildVectors() {
  const operatorA = syntheticAccount(0);
  const operatorB = syntheticAccount(1);
  const operatorD = syntheticAccount(2);
  const strangerC = syntheticAccount(3);

  const validPayload = payload(operatorA.address);
  const valid = await sign(operatorA, validPayload);
  const validDisclosureNone = await sign(
    operatorA,
    payload(operatorA.address, { humanIdDisclosure: 'none', nonce: 'ef'.repeat(32) }),
  );
  const expired = await sign(
    operatorA,
    payload(operatorA.address, {
      issuedAt: new Date(NOW_MS - 10 * DAY_MS).toISOString(),
      expiresAt: new Date(NOW_MS - 1000).toISOString(),
      nonce: 'ab'.repeat(32),
    }),
  );
  const notYetValid = await sign(
    operatorA,
    payload(operatorA.address, {
      issuedAt: new Date(NOW_MS + 2 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(NOW_MS + 30 * DAY_MS).toISOString(),
      nonce: 'ba'.repeat(32),
    }),
  );
  const longLifetime = await sign(
    operatorA,
    payload(operatorA.address, {
      issuedAt: new Date(NOW_MS - DAY_MS).toISOString(),
      expiresAt: new Date(NOW_MS + 91 * DAY_MS).toISOString(),
      nonce: 'dc'.repeat(32),
    }),
  );
  // Payload claims operatorA's wallet; the signature is strangerC's.
  const wrongSigner = await sign(strangerC, validPayload);
  // Pathological `extra` shapes (7.5 review M7/M8/m3). A `__proto__`
  // key must be bound by the signature, never dropped by a prototype
  // setter; integer-like keys must serialise lexicographically
  // ("1","10","2"), not numerically; astral-plane keys must sort by
  // Unicode code point (UTF-8 byte order), so U+E000 precedes
  // U+20000 even though UTF-16 code-unit order reverses them.
  const extraProtoKey = await sign(
    operatorA,
    payload(operatorA.address, {
      nonce: 'f1'.repeat(32),
      extra: JSON.parse(
        '{"__proto__":"proto-value","zeta":"last"}',
      ) as Record<string, string>,
    }),
  );
  const extraIntegerKeys = await sign(
    operatorA,
    payload(operatorA.address, {
      nonce: 'f2'.repeat(32),
      extra: { '2': 'two', '10': 'ten', '1': 'one', a: 'letter' },
    }),
  );
  const extraAstralKeys = await sign(
    operatorA,
    payload(operatorA.address, {
      nonce: 'f3'.repeat(32),
      extra: { '\uE000': 'bmp-private-use', '\u{20000}': 'astral-plane' },
    }),
  );

  // D5 (verifySignedMessage): an arbitrary caller-canonicalised
  // message, signed by operatorA. Tampered variants are derived in
  // the tests, not stored.
  const signedMessageText = 'fiador verifySignedMessage synthetic vector v1';
  const signedMessage = {
    message: signedMessageText,
    signature: await operatorA.signMessage({ message: signedMessageText }),
    signer: operatorA.address,
  };

  return {
    note: 'SYNTHETIC FIXTURES ONLY. Generated deterministically by scripts/gen-fixtures.ts. The fixture keys are public-by-construction: each private key is the keccak256 of a committed, labelled seed string in that file, so anyone can re-derive them. The fixture addresses are therefore BURNED — never fund them, never register them in AgentBook, never use them in a demo. No real wallet, humanId, or key material appears in this file.',
    fixedNow: FIXED_NOW_ISO,
    humans: { human1: HUMAN_1, human2: HUMAN_2 },
    wallets: {
      operatorA: operatorA.address,
      operatorB: operatorB.address,
      operatorD: operatorD.address,
      strangerC: strangerC.address,
    },
    lookups: [
      { address: operatorA.address, humanId: HUMAN_1 },
      { address: operatorB.address, humanId: HUMAN_1 },
      { address: operatorD.address, humanId: HUMAN_2 },
      { address: strangerC.address, humanId: null },
    ],
    attestations: {
      valid,
      validDisclosureNone,
      expired,
      notYetValid,
      longLifetime,
      wrongSigner,
      extraProtoKey,
      extraIntegerKeys,
      extraAstralKeys,
    },
    signedMessages: {
      operatorA: signedMessage,
    },
  };
}

export type Vectors = Awaited<ReturnType<typeof buildVectors>>;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const vectors = await buildVectors();
  const out = new URL('../fixtures/vectors.json', import.meta.url);
  writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`);
  console.log(`wrote ${out.pathname}`);
}
