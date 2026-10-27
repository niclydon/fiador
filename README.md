<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/fiador-banner.webp">
  <source media="(prefers-color-scheme: light)" srcset="assets/fiador-banner.webp">
  <img alt="Fiador" src="assets/fiador-banner.webp" width="100%">
</picture>

# Fiador — human-backed attestation for Discord bots

A Discord bot's profile tells you a name and an avatar, but little about
the person who operates it. Fiador is an open protocol for checking a
signed claim from a wallet registered by a unique, verified human using
[World ID](https://world.org) and AgentBook on World Chain. The claim
names a Discord application. Current Fiador code cannot prove that the
wallet holder controls that application.

The verifier establishes that a unique human registered the wallet
that signed the attestation. It does not prove application control.
It also does not prove that the human wrote any particular message,
endorses any particular output, or
controls the bot at this moment. Those limits are part of the
design, stated everywhere the badge appears, because a trust mark
that overstates itself is worse than none.

## How it works

1. The operator registers an agent wallet in AgentBook with their
   Orb-verified World ID, then signs an attestation binding their
   Discord application ID and bot user ID to that wallet. The
   attestation carries an expiry (90 days maximum), a nonce, and a
   hash of the human identifier, never the identifier itself.
2. The attestation is published at a URL and listed in a public
   registry mapping Discord application IDs to attestation URLs.
3. The self-hosted verifier bot and the locally built static verify page
   check the signature, expiry, and wallet registration. They display the
   operator claim with an application-control warning. The verifier
   bot does not grant or revoke the server's `Human-backed` role.

Verification is a live check at verification time, not a permanent
stamp: the badge assets in this repo render verified, expired, and
unverified states, in light and dark variants, because an honest
mark has to be able to say "no longer true."

## Privacy rules

- Attestations publish the signing wallet's full address and a hash of
  the human identifier, never the raw identifier. Fiador verifiers
  read the on-chain value for a check. Their default
  public results omit it; trusted local callers can explicitly request
  a raw internal result, which must never be published. AgentBook
  lookup and registration events are public. A disclosed registered
  wallet or this published hash can be matched against that finite
  public data to reveal the pseudonymous identifier and other wallets
  registered to it.
  Two bots backed by the same human also publish the same hash.
- An optional operator display name exists for operators who want
  to be named. It is off by default and never required.
- This repository does not contain live private keys or service tokens.
  Test signing keys and test identifiers are synthetic. The founding
  public attestation intentionally includes a dedicated wallet address,
  a human-identifier hash, and an operator display name.

## Status

Founding stage; status checked October 27, 2026. The protocol
specification is written ([docs/SPEC.md](docs/SPEC.md)). This
repository contains:

- The full protocol spec, including the verification order, the
  discovery model (registry plus install-time claim), and the
  honest limits of the proof
- The badge asset set (verified / expired / unverified, pill and
  icon, light and dark) under [assets/](assets/), with a dynamic
  served-badge design so the mark can reflect a live check
- The verify package, self-hosted Discord verifier bot, static verify
  page (`/verify/`), and registry source. The browser page
  has local tests and a protected preview route check. A local browser
  check fetched the public attestation and read World Chain successfully
  on October 26. The bot's role automation is disabled pending trusted
  proof of Discord application control.
- Root Vercel preview packaging for the site, browser page, registry,
  attestation, and `/v/` link previews ([runbook](docs/web-preview.md)).
  Local route checks and a protected preview smoke pass are recorded.
  [fiador.org](https://fiador.org) serves the site, public registry,
  founding attestation, [privacy page](https://fiador.org/privacy/), and
  [support page](https://fiador.org/support/). The production `/verify/`
  and `/v/` routes still return 404. A production browser check, Discord
  unfurl, and application-control witness remain unverified.
- A tested AgentKit free-trial integration in a private prototype,
  verified end to end against AgentBook with a real Orb-verified
  registration (October 25, 2026).

The live privacy and support pages also describe a separate owner-only
Slack trial. As of October 27, owner enrollment, Slack sign-in, and a
World ID check have not run live. The available source, local tests,
and protected previews do not establish a production verifier or
Discord application control.
Guild admins upgrading the verifier bot must manually audit existing
`Human-backed` role holders; stored legacy claims do not prove application
control, and the bot changes no roles.

## Design decisions already settled

- Self-hosted verifier for v1: every adopting server runs its own
  verifier with its own bot token. No central hosted bot holds
  role-granting power across servers.
- The verify code ships as a clearly separated package inside this
  repo first, designed for extraction when a second project needs
  it.
- Apache-2.0 throughout, so the protocol can be adopted without
  encumbrance.

## The wider program

Fiador is the first public project in a small program
exploring what becomes possible when agents can prove a unique
human stands behind them: presence-approved actions for personal
agent fleets, provenance seals for agent-written content, and
callback verification for agent assistants that deal with
businesses on a human's behalf. Those projects will appear as
their own repositories under the same author, built in the open
with the same rules: spec first, tests including the failure
cases, live verification evidence recorded, and a narrative entry
for every arc.

The founding narrative is at
[docs/narrative/2026-10-25-founding.md](docs/narrative/2026-10-25-founding.md).

## Author

Created by Nic Lydon. Copyright 2026 Nic Lydon, licensed under
Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)).

This is an independent project. It is not affiliated with or
endorsed by World, Worldcoin, or Tools for Humanity; "World ID"
and "AgentKit" are used descriptively to name the systems this
software interoperates with.
