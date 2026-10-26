import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import {
  createVerifier,
  hashHumanId,
  type AgentBookReader,
  type Verifier,
} from '@fiador/verify';
import { buildDraft, payloadHash } from '../src/draft.js';
import { signDraft } from '../src/sign.js';
import { verifyAttestation } from '../src/verify.js';
import { loadWalletFromEnvFile, parseEnvFile } from '../src/env.js';

// SYNTHETIC fixtures only. The private key is the well-known public
// Hardhat/Anvil development account #0 key — test material, not a secret,
// and never used outside this suite. The humanId is an invented constant.
const SYNTHETIC_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const SYNTHETIC_WALLET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OTHER_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const SYNTHETIC_HUMAN_ID = `0x${'cd'.repeat(32)}`;
const APP_ID = '1561422752521396254';
const NOW = new Date('2026-10-26T12:00:00Z');

function fakeVerifier(registered: boolean): Verifier {
  const reader: AgentBookReader = {
    lookupHuman: async (address) =>
      registered && address.toLowerCase() === SYNTHETIC_WALLET.toLowerCase()
        ? SYNTHETIC_HUMAN_ID
        : null,
  };
  // Fixed clock: the core checks issuedAt against `now`, and the fixture
  // payload is issued exactly at NOW.
  return createVerifier({ reader, now: () => NOW });
}

const draftOpts = {
  applicationId: APP_ID,
  walletAddress: SYNTHETIC_WALLET,
  attestationUrl: 'https://fiador.org/attestations/test.json',
  now: NOW,
  nonce: 'testnonce0123456789abcdef',
};

describe('draft', () => {
  it('builds the Discord-profile payload with the hash derived live', async () => {
    const payload = await buildDraft(fakeVerifier(true), draftOpts);
    expect(payload.version).toBe(1);
    expect(payload.subject).toEqual({ type: 'discord_application', id: APP_ID });
    expect(payload.agentWalletAddress).toBe(SYNTHETIC_WALLET);
    expect(payload.humanIdDisclosure).toBe('hash');
    expect(payload.extra).toEqual({
      discord_bot_user_id: APP_ID, // defaults to the application id
      human_id_hash: hashHumanId(SYNTHETIC_HUMAN_ID),
    });
    expect(payload.issuedAt).toBe('2026-10-26T12:00:00Z');
    expect(payload.expiresAt).toBe('2027-01-24T12:00:00Z'); // +90 days
    expect(payload.nonce).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(payload.operatorDisplayName).toBeUndefined(); // off by default (§3.1.1)
    expect(payloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('includes the operator name only on explicit opt-in', async () => {
    const payload = await buildDraft(fakeVerifier(true), {
      ...draftOpts,
      operatorName: 'Test Operator',
    });
    expect(payload.operatorDisplayName).toBe('Test Operator');
  });

  it('refuses to draft for an unregistered wallet', async () => {
    await expect(buildDraft(fakeVerifier(false), draftOpts)).rejects.toThrow(
      /not registered in AgentBook/,
    );
  });

  it('refuses an expiry window over the 90-day cap', async () => {
    await expect(
      buildDraft(fakeVerifier(true), { ...draftOpts, days: 91 }),
    ).rejects.toThrow(/90 days/);
  });
});

describe('sign and verify', () => {
  it('round trip: sign with the wallet key, core verifies it live', async () => {
    const verifier = fakeVerifier(true);
    const draft = await buildDraft(verifier, draftOpts);
    const signed = await signDraft(verifier, {
      draft,
      privateKey: SYNTHETIC_PRIVATE_KEY,
      now: NOW,
    });
    expect(signed.signatureType).toBe('eip191');
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);

    const publicResult = await verifyAttestation(verifier, signed);
    expect(publicResult.status).toBe('verified');
    expect(publicResult.humanHash).toBe(hashHumanId(SYNTHETIC_HUMAN_ID));
  });

  it('refuses to sign when the wallet is unregistered at signing time', async () => {
    const draft = await buildDraft(fakeVerifier(true), draftOpts);
    await expect(
      signDraft(fakeVerifier(false), {
        draft,
        privateKey: SYNTHETIC_PRIVATE_KEY,
        now: NOW,
      }),
    ).rejects.toThrow(/refusing to sign/);
  });

  it('refuses to sign with a key that does not control the wallet', async () => {
    const draft = await buildDraft(fakeVerifier(true), draftOpts);
    await expect(
      signDraft(fakeVerifier(true), {
        draft,
        privateKey: OTHER_PRIVATE_KEY,
        now: NOW,
      }),
    ).rejects.toThrow(/refusing to sign/);
  });

  it('refuses a draft whose human_id_hash is stale or tampered', async () => {
    const draft = await buildDraft(fakeVerifier(true), draftOpts);
    const tampered = {
      ...draft,
      extra: { ...draft.extra, human_id_hash: 'f'.repeat(64) },
    };
    await expect(
      signDraft(fakeVerifier(true), {
        draft: tampered,
        privateKey: SYNTHETIC_PRIVATE_KEY,
        now: NOW,
      }),
    ).rejects.toThrow(/re-run draft/);
  });
});

describe('env loading', () => {
  it('parses the playground env shape and loads the wallet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fiador-signer-test-'));
    const path = join(dir, '.env.test');
    writeFileSync(
      path,
      [
        '# synthetic test env',
        `AGENT_PRIVATE_KEY=${SYNTHETIC_PRIVATE_KEY}`,
        `AGENT_ADDRESS=${SYNTHETIC_WALLET}`,
        'PORT=4021',
        '',
      ].join('\n'),
      'utf8',
    );
    const wallet = loadWalletFromEnvFile(path);
    expect(wallet.privateKey).toBe(SYNTHETIC_PRIVATE_KEY);
    expect(wallet.address).toBe(SYNTHETIC_WALLET);
    expect(parseEnvFile('A=1\nB="two"\n# comment\n\nC=three')).toEqual({
      A: '1',
      B: 'two',
      C: 'three',
    });
    expect(readFileSync(path, 'utf8')).toContain('AGENT_PRIVATE_KEY'); // input only
  });

  it('throws when the key var is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fiador-signer-test-'));
    const path = join(dir, '.env.empty');
    writeFileSync(path, 'PORT=4021\n', 'utf8');
    expect(() => loadWalletFromEnvFile(path)).toThrow(/AGENT_PRIVATE_KEY/);
  });
});

describe('output hygiene scan', () => {
  it('no produced output carries the raw humanId or key material', async () => {
    const verifier = fakeVerifier(true);
    const draft = await buildDraft(verifier, draftOpts);
    const signed = await signDraft(verifier, {
      draft,
      privateKey: SYNTHETIC_PRIVATE_KEY,
      now: NOW,
    });
    const publicResult = await verifyAttestation(verifier, signed);
    const outputs = [
      JSON.stringify(draft),
      JSON.stringify(signed),
      JSON.stringify(publicResult),
    ];
    for (const out of outputs) {
      expect(out).not.toContain(SYNTHETIC_HUMAN_ID);
      expect(out).not.toContain(SYNTHETIC_PRIVATE_KEY);
      expect(out).not.toContain(SYNTHETIC_PRIVATE_KEY.slice(2));
      expect(out).not.toContain('"humanId"');
    }
    // The hash (public by design) is present; the truncated address is used.
    expect(outputs[2]).toContain(hashHumanId(SYNTHETIC_HUMAN_ID));
    expect(outputs[2]).not.toContain(SYNTHETIC_WALLET);
  });
});
