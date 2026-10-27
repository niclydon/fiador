import type { PublicVerifyResult } from '@fiador/verify';

// The per-check breakdown for verify_attestation (SPEC 11.2): a
// deterministic projection of the core's failure codes, fixed here so
// it cannot drift. The authoritative record is `failures` itself;
// this block is a consumer convenience derived from it and from the
// core's fixed check order (shape, binding, signature, dates, replay,
// registration).
//
// Honesty rule (7.5 review M5): a stage reports a substantive state
// only when a present failure code — or the final status, which the
// core's precedence rules make informative — PROVES that stage ran.
// In particular, when the result is 'unknown', a lookup failure code
// cannot by itself prove which network stage failed (the ERC-1271
// signature check and the registration lookup both surface
// lookup_failed / lookup_timeout), so stages the codes cannot vouch
// for report 'not_checked' rather than a fabricated pass.
export type CheckState = 'pass' | 'fail' | 'not_checked';

export interface AttestationChecks {
  signature: CheckState;
  binding: { subject: CheckState; wallet: CheckState };
  expiry: 'valid' | 'expired' | 'not_yet_valid' | 'lifetime_invalid' | 'not_checked';
  registration: 'registered' | 'unregistered' | 'unknown' | 'not_checked';
}

export function computeChecks(
  result: PublicVerifyResult,
  asserted: { subject: boolean; wallet: boolean },
): AttestationChecks {
  const failures = new Set<string>(result.failures);
  const shapeFailed =
    failures.has('malformed_attestation') || failures.has('unsupported_version');
  const lookupFailed =
    failures.has('lookup_failed') || failures.has('lookup_timeout');

  // Codes that can only be produced by stages AFTER the signature
  // step, plus statuses whose precedence guarantees the signature was
  // evaluated and passed (an invalid-signature document is 'invalid'
  // with signature_mismatch, and outranks all of these).
  const pastSignature =
    result.status === 'verified' ||
    result.status === 'unregistered' ||
    (!lookupFailed && (
      result.status === 'expired' ||
      failures.has('not_yet_valid') ||
      failures.has('expired') ||
      failures.has('attestation_lifetime_invalid')
    )) ||
    failures.has('replay_detected') ||
    failures.has('not_registered');
  // An 'invalid' whose only failures are binding codes also proves
  // the signature ran: the core collects binding first and continues,
  // and had the signature failed or the network died, its code would
  // be present too.
  const bindingOnlyInvalid =
    result.status === 'invalid' && !shapeFailed && !lookupFailed && !pastSignature;

  const signature: CheckState = failures.has('signature_mismatch')
    ? 'fail'
    : pastSignature || bindingOnlyInvalid
      ? 'pass'
      : 'not_checked';

  // Binding is step 2: it ran whenever the shape step passed, so an
  // asserted leg with no mismatch code passed — even if a later
  // network stage failed. An unasserted leg is never 'pass'.
  const bindingLeg = (assertedLeg: boolean, code: string): CheckState => {
    if (failures.has(code)) return 'fail';
    if (!assertedLeg) return 'not_checked';
    if (shapeFailed) return 'not_checked';
    return 'pass';
  };

  const pastDates =
    pastSignature ||
    failures.has('replay_detected') ||
    failures.has('not_registered');
  const expiry: AttestationChecks['expiry'] = failures.has('expired')
    ? 'expired'
    : failures.has('not_yet_valid')
      ? 'not_yet_valid'
      : failures.has('attestation_lifetime_invalid')
        ? 'lifetime_invalid'
        : shapeFailed
          ? 'not_checked'
          : pastDates || bindingOnlyInvalid || signature === 'pass'
            ? 'valid'
            : 'not_checked';

  // Registration is the final stage; only a resolved lookup leaves
  // evidence of itself in the result. An 'unknown' result cannot
  // prove the lookup (rather than the signature check) is what
  // failed, so it reports 'not_checked' here; the lookup failure
  // itself is carried, precisely, in `failures`.
  const registration: AttestationChecks['registration'] =
    result.status === 'verified'
      ? 'registered'
      : result.status === 'unregistered'
        ? 'unregistered'
        : 'not_checked';

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
