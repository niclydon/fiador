# The bot-response witness, exercised live

2026-10-27. Record of the W1 verifier bot's app-control
witness: what it was built to establish, what it deliberately
does not establish, and its first live run.

## Why this exists

A signed Fiador attestation proves that a wallet registered
to a unique human signed a claim about a Discord application.
It does not prove the signer controls that application: the
claim is self-asserted, and a bot can be made to echo
arbitrary text. Until control is proven independently, the
verifier bot creates no bindings, grants no roles, and the
public badge state stays neutral ("Claim unconfirmed").

The witness is the deliberately limited step that fits inside
that boundary. It records, once, that two fresh acts happened
inside a ten-minute window: the attestation wallet signed a
challenge binding the guild, channel, application, bot, and
nonce; and the named bot posted the matching public response
in that channel. Either act alone is cheap. Together they
are a dated, checkable fact about responsiveness, recorded
without ever asking for the target bot's token.

## What was built (PR #16)

`verifier-bot/src/appControl.ts` and its command surface:

- `/fiador control-start <url>` (Manage Guild): fetches and
  verifies the attestation through the core, rechecks the
  signed Discord profile and the published registry entry,
  confirms exactly one enabled guild integration matches the
  claimed application and bot, then issues the challenge.
- `/fiador control-complete <nonce> <signature> <message_id>`:
  re-runs the full attestation and registry checks, verifies
  the wallet signature, fetches the exact message and rejects
  webhooks, edits, forwards, crossposts, and interaction
  messages, re-reads the integration, and only then consumes
  the nonce in one atomic SQLite update. Failed checks leave
  the nonce unused.
- The private signature text never leaves the operator's
  hands; the public bot message carries only a mention of the
  verifier and the nonce. Neither text contains the humanId
  in any form; the store keeps no signature and no token.

Independent security and correctness reviews passed at the
merged head; the verifier-bot suite was 72/72, including
replay, expiry, concurrency, and malformed-registry cases.

## The live run

2026-10-27, in the operator's guild, in a private channel
created for the run. The verifier ran under the Fiador
application; the target was the Nova application's founding
attestation.

- 22:13:10Z: control-start opened the challenge; the
  pre-check recorded `verified`.
- The demo signing wallet signed the private challenge text;
  the Nova bot posted the public response (message
  `1564764158514299083`).
- 22:15:06Z: control-complete consumed the challenge; the
  completion check recorded `verified` with no failures.

The bot's own reply to the operator stated the boundary back:
a fresh witness recorded; application-operator control
remains unproven; no binding or role changed. PR #16, held
draft until a real witness was exercised, merged the same
day as squash `1840cb7`.

## What remains

The witness is evidence of responsiveness, not authority.
A protocol that proves the signing wallet's authority over
the Discord application itself, without disclosing the target
bot's credentials to a verifier, is still unbuilt; Discord
exposes no cross-application operator assertion a self-hosted
verifier can consume. Role automation and any verified-bot
claim stay off until that protocol exists and is itself
exercised live.
