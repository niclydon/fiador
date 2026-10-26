import type { PublicVerifyResult } from '@fiador/verify';

// The per-check breakdown for verify_attestation (SPEC 11.2): a
// deterministic projection of the core's failure codes, fixed here so
// it cannot drift. The authoritative record is `failures` itself; this
// block is a consumer convenience derived from it and from the core's
// fixed check order (shape, binding, signature, dates, replay,
// registration). Where the failure set cannot prove a step ran, the
// check reports 'not_checked' rather than guessing.
export type CheckState = 'pass' | 'fail' | 'not_checked';

export interface AttestationChecks {
  signature: CheckState;
  binding: { subject: CheckState; wallet: CheckState };
  expiry: 'valid' | 'expired' | 'not_yet_valid' | 'not_checked';
  registration: 'registered' | 'unregistered' | 'unknown' | 'not_checked';
}

export function computeChecks(
  result: PublicVerifyResult,
  asserted: { subject: boolean; wallet: boolean },
): AttestationChecks {
  const failures = new Set<string>(result.failures);
  const shapeFailed =
    failures.has('malformed_attestation') || failures.has('unsupported_version');
  // Post-signature stages leave codes of their own; any of these (or a
  // clean verdict past the signature step) proves the signature ran.
  const pastSignature =
    result.status === 'verified' ||
    result.status === 'expired' ||
    result.status === 'unregistered' ||
    failures.has('not_yet_valid') ||
    failures.has('expired') ||
    failures.has('replay_detected') ||
    failures.has('not_registered') ||
    failures.has('lookup_failed') ||
    failures.has('lookup_timeout');

  const signature: CheckState = failures.has('signature_mismatch')
    ? 'fail'
    : pastSignature
      ? 'pass'
      : 'not_checked';

  const bindingLeg = (assertedLeg: boolean, code: string): CheckState => {
    if (failures.has(code)) return 'fail';
    if (!assertedLeg) return 'not_checked';
    if (shapeFailed && !pastSignature) return 'not_checked';
    return 'pass';
  };

  const expiry: AttestationChecks['expiry'] = failures.has('expired')
    ? 'expired'
    : failures.has('not_yet_valid')
      ? 'not_yet_valid'
      : shapeFailed && !pastSignature
        ? 'not_checked'
        : 'valid';

  const registration: AttestationChecks['registration'] =
    result.status === 'verified'
      ? 'registered'
      : result.status === 'unregistered'
        ? 'unregistered'
        : result.status === 'unknown'
          ? 'unknown'
          : 'not_checked'; // invalid or expired: the lookup never ran

  return {
    signature,
    binding: {
      subject: bindingLeg(asserted.subject, 'subject_mismatch'),
      wallet: bindingLeg(asserted.wallet, 'wallet_mismatch'),
    },
    expiry,
    registration,
  };
}
