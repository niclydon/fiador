// Verification passthrough: the core's verifyAttestation, projected to the
// PUBLIC result shape before anything is printed (§3.3 / core §3.0). The
// internal result — the only place a humanId could ever ride — never
// leaves this function.

import {
  toPublicVerifyResult,
  type PublicVerifyResult,
  type Verifier,
} from '@fiador/verify';

export async function verifyAttestation(
  verifier: Verifier,
  attestation: unknown,
): Promise<PublicVerifyResult> {
  const result = await verifier.verifyAttestation(attestation);
  return toPublicVerifyResult(result);
}
