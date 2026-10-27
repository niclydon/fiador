import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { canonicalAttestationMessage, createVerifier, hashHumanId } from '@fiador/verify';
import type { SignedAttestation, Verifier, VerifyResult } from '@fiador/verify';
import { privateKeyToAccount } from 'viem/accounts';
import { checkAttestation } from '../src/check.js';

const signed = JSON.parse(readFileSync(fileURLToPath(new URL('../attestations/nova.json', import.meta.url)), 'utf8')) as SignedAttestation;
const entry = {
  discord_application_id: signed.payload.subject.id,
  attestation_url: signed.payload.attestationUrl!,
};
const fullWallet = signed.payload.agentWalletAddress;
const fullHash = signed.payload.extra!.human_id_hash;

function verifier(status: VerifyResult['status'], failures: VerifyResult['failures'] = []): Verifier {
  const result: VerifyResult = {
    status,
    address: fullWallet,
    addressTruncated: '0x21BD…A14Bc',
    humanHash: status === 'verified' ? fullHash : null,
    failures,
    evidence: {
      checkedAt: '2026-10-26T12:00:00.000Z',
      source: 'live',
      agentBook: { network: 'eip155:480', contract: '0xA23aB2712eA7BBa896930544C7d6636a96b944dA' },
    },
    disclosure: 'hash',
  };
  return { verifyAttestation: vi.fn().mockResolvedValue(result) } as unknown as Verifier;
}

describe('browser result boundary', () => {
  it('uses the real shared core for a signed Discord profile and a live-style reader', async () => {
    const account = privateKeyToAccount(`0x${'12'.repeat(32)}`);
    // A humanId in the canonical shape (0x-prefixed 32-byte hex):
    // the core fails closed on any other reader value (verify
    // fix pass 2, N1), so a "live-style" reader must answer in
    // the shape the live reader reads from AgentBook.
    const humanId = `0x${'42'.repeat(32)}`;
    const url = 'https://example.org/attestation.json';
    const applicationId = '123456789012345678';
    const payload: SignedAttestation['payload'] = {
      version: 1,
      subject: { type: 'discord_application', id: applicationId },
      agentWalletAddress: account.address,
      attestationUrl: url,
      humanIdDisclosure: 'hash',
      issuedAt: '2026-10-25T12:00:00Z',
      expiresAt: '2026-11-01T12:00:00Z',
      nonce: '0123456789abcdef0123456789abcdef',
      extra: { discord_bot_user_id: applicationId, human_id_hash: hashHumanId(humanId) },
    };
    const attestation: SignedAttestation = {
      payload,
      signature: await account.signMessage({ message: canonicalAttestationMessage(payload) }),
      signatureType: 'eip191',
    };
    const core = createVerifier({
      now: () => new Date('2026-10-26T12:00:00Z'),
      reader: { source: 'live', lookupHuman: async () => humanId },
    });
    const result = await checkAttestation({
      attestation,
      verifier: core,
      entry: { discord_application_id: applicationId, attestation_url: url },
      registryChecked: true,
    });
    expect(result.state).toBe('claim_unconfirmed');
    expect(result.humanHashTruncated).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain(humanId);
    expect(JSON.stringify(result)).not.toContain(account.address);
  });

  it('never upgrades a core-valid Discord claim to application-control proof', async () => {
    const core = verifier('verified');
    const result = await checkAttestation({ attestation: signed, verifier: core, entry, registryChecked: true });
    expect(result.state).toBe('claim_unconfirmed');
    expect(result.verdict).toContain('Control of the named Discord application is not established');
    expect(result.operatorName).toBe('Nic Lydon');
    expect(result.humanHashTruncated).not.toBe(fullHash);
    expect(JSON.stringify(result)).not.toContain(fullWallet);
    expect(core.verifyAttestation).toHaveBeenCalledWith(signed, {
      expectedSubject: { type: 'discord_application', id: entry.discord_application_id },
    });
  });

  it('rejects a signed human hash that disagrees with the live result', async () => {
    const core = verifier('verified');
    const mismatch = { ...signed, payload: { ...signed.payload, extra: { ...signed.payload.extra, human_id_hash: 'a'.repeat(64) } } };
    const result = await checkAttestation({ attestation: mismatch, verifier: core, entry, registryChecked: true });
    expect(result.state).toBe('unverified');
    expect(result.verdict).toContain('does not match the live AgentBook result');
    expect(result.operatorName).toBeUndefined();
  });

  it('requires the signed URL to match the registry and does not hide lookup failures', async () => {
    const different = { ...entry, attestation_url: 'https://example.org/other.json' };
    const mismatch = await checkAttestation({ attestation: signed, verifier: verifier('verified'), entry: different, registryChecked: true });
    expect(mismatch.state).toBe('unverified');
    expect(mismatch.verdict).toContain('signed attestation URL');

    const unknown = await checkAttestation({ attestation: signed, verifier: verifier('unknown', ['lookup_failed']), entry, registryChecked: true });
    expect(unknown.state).toBe('could_not_check');
    expect(unknown.verdict).toContain('not a negative verdict');
    expect(unknown.humanHashTruncated).toBeUndefined();
  });

  it('labels checks without registry evidence and never reports expired claims as current', async () => {
    const unlisted = await checkAttestation({ attestation: signed, verifier: verifier('verified'), fetchedUrl: entry.attestation_url, registryChecked: false });
    expect(unlisted.state).toBe('claim_unconfirmed');
    expect(unlisted.note).toContain('cannot rule out revocation');

    const expired = await checkAttestation({ attestation: signed, verifier: verifier('expired', ['expired']), entry, registryChecked: true });
    expect(expired.state).toBe('expired');
    expect(expired.humanHashTruncated).toBeUndefined();
  });
});
