// Test double for '@fiador/verify' (aliased in vitest.config.ts).
//
// Re-exports the REAL public-shape helpers from the verify package's
// types module — toPublicVerifyResult, hashHumanId, truncateAddress,
// canonicalAttestationBytes — so the projection behaviour under test is
// the production code, not a copy. Only createVerifier is faked, with
// programmable per-application results.
//
// The synthetic verified fixture deliberately carries a raw humanId in
// the INTERNAL result ('0x' + '11'.repeat(32)) so tests can prove the
// public projection — and everything rendered from it — never contains it.

import {
  hashHumanId,
  toPublicVerifyResult,
  truncateAddress,
  type AttestationPayloadV1,
  type SignedAttestation,
  type VerifyResult,
} from '../../packages/verify-ts/src/types.ts';

export * from '../../packages/verify-ts/src/types.ts';
export { hashHumanId, toPublicVerifyResult, truncateAddress };

export const SYNTHETIC_HUMAN_ID = `0x${'11'.repeat(32)}`;
export const SYNTHETIC_WALLET = '0x1234567890AbcdEF1234567890aBcdef12345678' as const;

export function makePayload(overrides: Partial<AttestationPayloadV1> = {}): AttestationPayloadV1 {
  return {
    version: 1,
    subject: { type: 'discord_application', id: '123456789012345678' },
    agentWalletAddress: SYNTHETIC_WALLET,
    attestationUrl: 'https://operator.example.com/attestation.json',
    humanIdDisclosure: 'hash',
    issuedAt: '2026-10-25T00:00:00.000Z',
    expiresAt: '2026-12-24T00:00:00.000Z',
    nonce: 'test-nonce-0123456789abcdef',
    extra: { discord_bot_user_id: '987654321098765432' },
    ...overrides,
  };
}

export function makeAttestation(overrides: Partial<AttestationPayloadV1> = {}): SignedAttestation {
  return {
    payload: makePayload(overrides),
    signature: `0x${'ab'.repeat(65)}`,
    signatureType: 'eip191',
  };
}

export function makeResult(
  status: VerifyResult['status'],
  overrides: Partial<VerifyResult> = {},
): VerifyResult {
  const verified = status === 'verified';
  return {
    status,
    address: SYNTHETIC_WALLET,
    addressTruncated: truncateAddress(SYNTHETIC_WALLET),
    humanHash: verified ? hashHumanId(SYNTHETIC_HUMAN_ID) : null,
    // Internal-only field: present in the fake's verified result so the
    // deep-scan test has something real to hunt for.
    humanId: verified ? SYNTHETIC_HUMAN_ID : null,
    failures: verified
      ? []
      : [
          status === 'expired'
            ? 'expired'
            : status === 'unregistered'
              ? 'not_registered'
              : status === 'invalid'
                ? 'signature_mismatch'
                : 'lookup_failed',
        ],
    evidence: {
      checkedAt: '2026-10-26T04:00:00.000Z',
      source: 'fixture',
      agentBook: {
        network: 'eip155:480',
        contract: '0xA23aB2712eA7BBa896930544C7d6636a96b944dA',
      },
    },
    ...overrides,
  };
}

export interface FakeVerifierControls {
  /** Status returned for verifyAttestation / per-application checks. */
  status: VerifyResult['status'];
  /** Optional per-application status overrides. */
  byApplication: Map<string, VerifyResult['status']>;
}

export const fakeControls: FakeVerifierControls = {
  status: 'verified',
  byApplication: new Map(),
};

export function resetFakeVerifier(status: VerifyResult['status'] = 'verified'): void {
  fakeControls.status = status;
  fakeControls.byApplication.clear();
}

/** Minimal Verifier stand-in with the W0 spec §3 surface. */
export function createVerifier(): {
  verifyAddress: (address: string) => Promise<VerifyResult>;
  verifyAttestation: (
    attestation: unknown,
    opts?: { expectedSubject?: { type: string; id: string } },
  ) => Promise<VerifyResult>;
  resolveStatus: (subject: unknown) => Promise<VerifyResult>;
} {
  const statusFor = (applicationId?: string) =>
    (applicationId && fakeControls.byApplication.get(applicationId)) || fakeControls.status;

  return {
    async verifyAddress() {
      return makeResult(statusFor());
    },
    async verifyAttestation(attestation: unknown) {
      const appId = (attestation as SignedAttestation | null)?.payload?.subject?.id;
      return makeResult(statusFor(appId));
    },
    async resolveStatus(subject: unknown) {
      const s = subject as {
        kind: string;
        subject?: { id: string };
        resolveAttestation?: (subj: { type: string; id: string }) => Promise<SignedAttestation | null>;
      };
      if (s.kind === 'attested_subject' && s.resolveAttestation && s.subject) {
        const attestation = await s.resolveAttestation(s.subject);
        if (!attestation) {
          return makeResult('unknown', { failures: ['attestation_not_found'] });
        }
        return makeResult(statusFor(s.subject.id));
      }
      if (s.kind === 'attestation') {
        const attestation = (s as { attestation: SignedAttestation }).attestation;
        return makeResult(statusFor(attestation.payload.subject.id));
      }
      return makeResult(statusFor());
    },
  };
}
