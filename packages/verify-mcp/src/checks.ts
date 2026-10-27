import type { PublicVerifyResult, RegistrationLookupFact } from '@fiador/verify';

// The per-check breakdown for verify_attestation (SPEC 11.2): a
// deterministic projection of the core's failure codes, fixed here so
// it cannot drift. The authoritative record is `failures` itself;
// this block is a consumer convenience derived from it and from the
// core's fixed check order (shape, binding, signature, dates, replay,
// registration).
//
// SPEC 11.2's mapping, restored exactly (7.5 re-review M5):
// - signature: fail iff signature_mismatch (or a malformed
//   document); pass when the pipeline demonstrably reached and
//   cleared the signature step; not_checked when the shape step
//   failed — and when a lookup failure makes it impossible to prove
//   the signature was ever evaluated.
// - expiry: expired/not_yet_valid/lifetime_invalid iff the matching
//   code is present; valid whenever the shape step passed and no
//   date code is present (the core evaluates dates on every
//   post-shape path); not_checked only on shape failure.
// - registration: registered when the lookup resolved with an
//   entry; unregistered when it resolved null; UNKNOWN when the
//   lookup ran and failed; not_checked only when the pipeline
//   failed before the lookup step.
//
// Which stages ran is FACT, not inference (fix pass 3, D6): the
// core records the step-6 lookup's fate on the internal result
// (`registration`), and the server hands that fact to this
// projection alongside the public result. An earlier version of
// this projection inferred "the registration lookup ran" from
// the pair (status 'unknown', evidence.rpcLatencyMs present);
// that inference was wrong for every claim-store outcome — a
// claim replay, a claim expiry, and a claim failure all follow a
// completed registration lookup but carry no latency, so they
// were misreported as not_checked. When the caller supplies no
// fact (unit tests of this projection, older cores), only the
// certainties remain: a verified result's lookup resolved with
// an entry, an unregistered result's resolved null.
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
  registrationFact?: RegistrationLookupFact,
): AttestationChecks {
  const failures = new Set<string>(result.failures);
  const shapeFailed =
    failures.has('malformed_attestation') || failures.has('unsupported_version');
  const lookupFailed =
    failures.has('lookup_failed') || failures.has('lookup_timeout');
  // The registration lookup ran (core-recorded fact, D6). Reaching
  // registration at all also proves the signature stage cleared:
  // the pipeline only gets there past it.
  const registrationRan = registrationFact?.ran === true;
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
    failures.has('replay_detected') ||
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
    registrationFact !== undefined
      ? !registrationFact.ran
        ? 'not_checked'
        : registrationFact.outcome === 'registered'
          ? 'registered'
          : registrationFact.outcome === 'unregistered'
            ? 'unregistered'
            : 'unknown'
      : result.status === 'verified'
        ? 'registered'
        : result.status === 'unregistered' || notRegistered
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
