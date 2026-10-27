import type { PublicVerifyResult } from '@fiador/verify';

// The per-check breakdown for verify_attestation (SPEC 11.2): a
// deterministic projection of the core's failure codes, fixed here so
// it cannot drift. The authoritative record is `failures` itself;
// this block is a consumer convenience derived from it and from the
// core's fixed check order (shape, binding, signature, dates, replay,
// registration).
//
// SPEC 11.2's mapping, restored exactly (7.5 re-review M5):
// - signature: fail iff signature_mismatch; pass when the pipeline
//   demonstrably cleared the signature step; not_checked when shape
//   failed or a lookup failure makes signature success unproven.
//   A read-only replay check after
//   an uncertain ERC-1271 result proves replay, not signature success.
// - expiry: expired/not_yet_valid/lifetime_invalid iff the matching
//   code is present; valid whenever the shape step passed and no
//   date code is present (the core evaluates dates on every
//   post-shape path); not_checked only on shape failure.
// - registration: registered when the lookup resolved with an
//   entry; unregistered when it resolved null; UNKNOWN when the
//   lookup ran and failed; not_checked only when the pipeline
//   failed before the lookup step.
//
// Proving which network stage a lookup failure came from: the
// registration lookup is the only stage whose outcome carries
// `evidence.rpcLatencyMs` (the core records lookup latency only
// there for attestation results; an ERC-1271 signature-stage
// failure returns before any latency is recorded), and a failed
// registration lookup is also the only lookup failure that
// produces status 'unknown' — earlier-stage failures surface as
// 'invalid' or 'expired' with their established codes preserved,
// and claim-store failures carry no latency. The pair (status
// 'unknown', latency present) therefore proves the registration
// lookup ran — and, since the pipeline only reaches registration
// after the signature cleared, it also proves the signature
// passed. A not_registered failure likewise proves both stages
// ran.
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
  // The registration lookup demonstrably ran (see the header note).
  const registrationRan =
    result.status === 'unknown' && result.evidence.rpcLatencyMs !== undefined;
  const notRegistered = failures.has('not_registered');

  // Codes that can only be produced at or after the dates step,
  // plus statuses whose precedence guarantees the signature was
  // evaluated and passed (an invalid-signature document is
  // 'invalid' with signature_mismatch and outranks all of these).
  // Under a lookup failure these are NOT evidence the signature ran
  // (7.5 re-review M5): when the ERC-1271 check itself is what
  // failed, the core preserves binding and date failures computed
  // from the payload, so a date code — or a bare expired status —
  // can accompany a signature that was never evaluated.
  const pastSignature =
    result.status === 'verified' ||
    result.status === 'unregistered' ||
    (failures.has('replay_detected') && !lookupFailed) ||
    notRegistered;
  const pastSignatureViaDates =
    !lookupFailed &&
    (result.status === 'expired' ||
      failures.has('not_yet_valid') ||
      failures.has('expired') ||
      failures.has('attestation_lifetime_invalid'));
  // An 'invalid' whose only failures are binding codes also proves
  // the signature ran: the core collects binding first and
  // continues, and had the signature failed or the network died,
  // its code would be present too.
  const bindingOnlyInvalid =
    result.status === 'invalid' &&
    !shapeFailed &&
    !lookupFailed &&
    !pastSignature &&
    !pastSignatureViaDates;

  const signature: CheckState = failures.has('signature_mismatch')
    ? 'fail'
    : registrationRan || notRegistered || pastSignature || pastSignatureViaDates || bindingOnlyInvalid
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

  // Dates are evaluated on every post-shape path in the core, so
  // expiry is a fact whenever the shape step passed: the matching
  // code if present, 'valid' otherwise (SPEC 11.2, read literally).
  const expiry: AttestationChecks['expiry'] = shapeFailed
    ? 'not_checked'
    : failures.has('expired')
      ? 'expired'
      : failures.has('not_yet_valid')
        ? 'not_yet_valid'
        : failures.has('attestation_lifetime_invalid')
          ? 'lifetime_invalid'
          : 'valid';

  const registration: AttestationChecks['registration'] =
    result.status === 'verified'
      ? 'registered'
      : result.status === 'unregistered' || notRegistered
        ? 'unregistered'
        : lookupFailed && registrationRan
          ? 'unknown'
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
