# 2026-10-26 — the founding attestation

DESIGN §9 step 1 is complete. Fiador now has a real, published
attestation of its own kind: not a fixture, not a demo against a
fake reader, but a signed payload naming a live Discord
application, issued by a wallet whose AgentBook registration was
checked against the real contract at signing time and again at
publication.

## How it got here

The W0 verify core had already merged (PR #1): canonical message
form, hash-only disclosure, the five-state status model, and a
reader that keeps `unregistered` and `unknown` apart. The
reference signer (PR #4) was built directly on that core —
`draft`, `sign`, and `verify` subcommands that reimplement
nothing. Drafting runs the core's live verification on the
wallet and takes the payload's `human_id_hash` from the result;
signing re-checks registration, hash freshness, key control, and
expiry before it will produce a signature; verifying prints only
the public projection. The signer's hygiene test asserts that no
produced file or output carries a raw humanId or key material.

The founding payload binds Discord application
1561422752521396254 (Nova; the bot user ID is the same number)
to the dedicated demo signing wallet, carries the operator
display name under Nic's explicit opt-in, pins disclosure
to `hash`, and runs the maximum 90-day term: issued
2026-10-26, expiring 2027-01-24. Its canonical payload hash is
8bfeb9f9182de3ce63cdf42bdff941277250d96089982c65f0f97761f195a031.

## Signing and verification evidence

The attestation was signed with the demo signing wallet on
2026-10-26 and verified live, through the signer's own verify
command, against the real AgentBook contract on World Chain
(eip155:480): status `verified` at 2026-10-26T10:10:50Z, with
the derived human hash matching the prefix W0 recorded for this
wallet in docs/verification.md when the core first verified it.
The hash was reproduced from the live lookup at draft, sign,
and verify time; it was never copied from a stored value.

## What publication is

This PR publishes in two parts. The registry gains its first
entry (registry/registry.json, with its JSON Schema and
contribution rules), and a minimal static site under
verify-page/ becomes the hosting root for fiador.org on Vercel:
the attestation served byte-for-byte at /attestations/nova.json,
the registry mirrored at /registry.json, and a one-page front
door that states what Fiador is, with the descriptor the naming
decision requires and the honest limits of what an attestation
proves. The full interactive verify page (DESIGN §6.1) is later
work; this root exists so the attestation and registry have
their canonical home now.

## What this is not

This is §9 step 1, not a launch. Still standing between here
and any launch claim:

- §9 steps 2–5a: package, page, packaged-bot, badge, and
  link-preview runs against this attestation in a live guild.
- The §10 adversarial review, which gates any public identity
  claim made with this code.
- The badge service and the full §6.1 verify page.

The attestation expires on 2027-01-24 whether or not any of
that lands; re-issuance is a signer run, by design.
