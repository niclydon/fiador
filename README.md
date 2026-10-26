<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/fiador-banner.webp">
  <source media="(prefers-color-scheme: light)" srcset="assets/fiador-banner.webp">
  <img alt="Fiador" src="assets/fiador-banner.webp" width="100%">
</picture>

# Fiador

A Discord bot's profile tells you a name, an avatar, and nothing
about whether anyone real stands behind it. Fiador — human-backed attestation for Discord
bots — is an open protocol and verifier that lets a bot operator prove, in a way any
server admin can check, that their bot is backed by one unique,
verified human, using [World ID](https://world.org) and AgentBook
registrations on World Chain.

It proves exactly one thing: a unique human registered the wallet
that signed this bot's attestation. It does not prove the human
wrote any particular message, endorses any particular output, or
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
3. A verifier a server admin installs once (or the no-install
   static verify page) checks the signature, checks the expiry,
   and resolves the wallet live in AgentBook. Passing bots receive
   the server's "Human-backed" role.

Verification is a live check at verification time, not a permanent
stamp: the badge assets in this repo render verified, expired, and
unverified states, in light and dark variants, because an honest
mark has to be able to say "no longer true."

## Privacy rules

- Attestations publish a hash of the humanId, never the full value.
  Verifiers resolve the full value privately through the on-chain
  lookup. Two bots backed by the same human produce the same hash,
  which is the one correlation the system intends to allow.
- An optional operator display name exists for operators who want
  to be named. It is off by default and never required.
- Nothing in this repo contains keys, tokens, or personal data.
  Demo material uses synthetic identifiers only.

## Status

Founding stage, October 2026. The protocol specification is
written ([docs/SPEC.md](docs/SPEC.md)); implementation is in
design. What exists today:

- The full protocol spec, including the verification order, the
  discovery model (registry plus install-time claim), and the
  honest limits of the proof
- The badge asset set (verified / expired / unverified, pill and
  icon, light and dark) under [assets/](assets/), with a dynamic
  served-badge design so the mark can reflect a live check
- A tested AgentKit free-trial integration in a private prototype,
  verified end to end against AgentBook with a real Orb-verified
  registration (October 25, 2026); its verification code is being
  extracted into this repo as the verify package

What does not exist yet: the verifier bot, the static verify page,
and the registry. The build order is in the spec.

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
