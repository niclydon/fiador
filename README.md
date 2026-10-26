<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/fiador-banner.webp">
  <source media="(prefers-color-scheme: light)" srcset="assets/fiador-banner.webp">
  <img alt="Fiador" src="assets/fiador-banner.webp" width="100%">
</picture>

# Fiador

A Discord bot's profile tells you a name, an avatar, and nothing
about whether anyone real stands behind it. Fiador — human-backed attestation for Discord
bots — is an open protocol and verifier intended to let an operator
prove that a bot is backed by one unique, verified human, using
[World ID](https://world.org) and AgentBook registrations on World Chain.
The current preview can verify the wallet's signed claim and live
registration, but it has no trusted proof that the wallet holder
controls the named Discord application.

The current cryptographic check proves that a unique human registered
the wallet that signed a claim naming a Discord application. It does
not prove the signer controls that application, that the human wrote
any particular message, endorses any particular output, or controls
the bot at this moment. Those limits are part of the
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
3. A self-hosted verifier checks the signature, checks the expiry,
   and resolves the wallet live in AgentBook. The no-install browser
   verification page is implemented in PR #10 and locally tested;
   deployed click-through, browser CORS/RPC behavior, and trusted
   application-control evidence remain to be verified.

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
- No private keys, tokens, or raw humanIds belong in this repo. The
  published founding attestation necessarily includes its signing
  wallet address; test fixtures use synthetic identifiers.

## Status

Founding build, October 2026:

- [The protocol spec](docs/SPEC.md), design, and badge
  assets are present. The TypeScript verify core and read-only MCP
  package are implemented and tested; [live verification evidence](docs/verification.md)
  records the core's AgentBook check and both MCP transports.
- The reference signer, founding attestation, and first registry entry
  are built. The registry's repo source is
  [registry/registry.json](registry/registry.json), mirrored in the
  static hosting root as `/registry.json`.
- The self-hosted verifier bot has commands, local state, role sync,
  and guarded attestation fetching. Its tests use fakes; a complete
  live Discord guild run of this Fiador bot has not been verified.
  Its application-control gate also remains to be established before
  role grants can be treated as proof about a named bot.
- The `/v/<short-id>` preview handler and cards are implemented and
  locally tested. Core-valid claims render **Claim unconfirmed**;
  malformed Discord profile claims render **Not verified**. The
  interactive `/verify/` page is implemented in PR #10 and locally
  tested, with three input modes and a fresh browser check for `/v/`
  redirects. Deployed click-through, CORS/RPC behavior, and application
  control are still pending. The served badge remains to be built, and
  the SVG Open Graph image needs a raster fallback for platforms that
  do not display SVG previews.

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
