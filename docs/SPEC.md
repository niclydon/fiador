# Fiador — human-backed attestation for Discord bots: public repo spec

Status: founding spec, Oct 25, 2026; reconciled with the build on
Oct 26, 2026. Fiador now has a public repo, a verify package, a
static verify page, and a self-hosted Discord check-and-log bot.
`docs/DESIGN.md` defines the current wire format and build details.
The role automation originally proposed here is held: a wallet can
sign a valid claim naming someone else's Discord application, so a
passing attestation cannot authorize a guild role change.

## The integration model (who does what)

Three parties, three jobs. The repo serves all three; no party's part
lives inside another party's code.

- The claimant attests: they hold an agent wallet
  registered in AgentBook on World Chain to their Orb-verified World
  ID, and they publish a signed attestation naming a Discord
  application. The signature alone does not establish that they
  own or operate that application.
- The verifier checks: given a Discord application ID, it fetches the
  attestation, verifies the wallet signature, and reads AgentBook live
  to confirm the wallet is registered to a unique human.
- The guild (Discord server) decides: its verifier checks and logs
  operator claims. Admins separately establish application control
  and manually audit any "Human-backed" role holders. The current
  bot does not grant or remove roles on join, `/attest`, or sync.
  A checked claim alone must not gate channels or permissions.

What does NOT live where:

- Not in muse-discord. muse-discord is one bot framework among many
  (upstream: cszach; Nic's fork: niclydon/muse-discord, private). A
  muse-discord plugin is one optional adapter, later. Baking the
  protocol into one framework would kill the point of a public repo.
- Not with the Discord server owner as a code review. A community
  server's owner or admins decide whether to run the verifier,
  review independent control evidence, and set any manual role
  policy. No PR goes to them.
- Not as a World product. This is independent open source built on
  World's public surfaces (AgentBook contract, agentkit SDK). The
  README must say so plainly, with no implied endorsement.

## The attestation

The fields below describe the founding shape; the canonical signed
envelope, field names, and signing rules are in `docs/DESIGN.md` §3.
The operator wallet signs the claim:

- discord_application_id (the bot's application ID, stable across
  every server the bot joins; this is the identity being attested)
- discord_bot_user_id
- agent_wallet_address
- operator_display_name (optional, self-asserted, labelled as such)
- attestation_url (where this payload is hosted)
- issued_at, expires_at (90 days max; re-signing is the renewal)
- nonce

Verification, in order:

1. Signature recovers to agent_wallet_address
2. Not expired
3. AgentBook lookupHuman(agent_wallet_address) returns non-null on
   World Chain (contract 0xA23aB2712eA7BBa896930544C7d6636a96b944dA,
   network eip155:480; figures from the Oct 24, 2026 playground work,
   re-verify against current World docs at build time)
4. The verifier displays a hash of the humanId so a guild can see
   when two different bots trace to the same human. SETTLED PRIVACY
   RULE (Nic-direct Oct 25, 2026): Fiador never copies the full
   humanId into its payload, repo, or public outputs. Hash only, no
   operator override in v1. AgentBook itself is public on World
   Chain: a disclosed registered wallet can expose that identifier
   and link other wallets registered to it. Any agent working from
   this spec: do not place the raw humanId in code fixtures, docs,
   screenshots, logs, or messages outside the estate.

Discovery, the genuinely hard part. A verifier asked about a
Discord application has its ID, but Discord profiles carry no
reliable custom attestation URL. Two mechanisms are in scope:

- Registry: a JSON registry (in the public repo, or a hosted copy)
  mapping discord_application_id to attestation_url. Operators add
  themselves by PR or by a submission flow. Simple, auditable, and
  the v1 answer.
- Install-time claim: the operator, who is usually the person adding
  the bot, runs the verifier bot's /attest command in that guild and
  pastes the attestation URL or payload. The verifier checks and
  logs the claim, including for an unlisted application. It
  creates no new guild binding and grants no role. Existing
  bindings are legacy claims, not application-control proof.

## Repo contents (v1)

- SPEC.md: this protocol, versioned
- packages/verify-ts and packages/verify-py: verify signed claims
  and AgentBook registrations with explicit statuses and evidence
  (current API in `docs/DESIGN.md` §4). A core `verified` status
  says the wallet claim passed, not that the Discord application
  is controlled by the signer.
- verifier-bot/: a reference Discord bot any guild can self-host (or
  a hosted instance can be considered later). Slash commands:
  `/fiador status` and `/fiador setup`, `/verify-agent`
  (application ID), and `/attest` (presented claim). The bot
  checks and logs claims. It rechecks legacy bindings on a timer
  but makes no role changes for any status, including a passing
  claim, expiry, or registration failure. Admins audit existing
  role holders manually. Draft PR #16 adds a limited wallet and
  bot-response witness; it still proves no operator authority
  and changes no role.
- verify-page/: a static page that does the whole check client-side
  (signature recovery plus a World Chain RPC read) so a human can
  verify with no server of ours in the loop
- registry/registry.json plus its schema and contribution rules
- examples/: minimal integrations: a raw discord.js bot, a discord.py
  bot, and a static "publish your attestation" walkthrough. The
  muse-discord plugin adapter is a v2 example, not v1
- README.md written for a stranger: what this proves, what it does
  not prove (below), quickstart for operators, for guild admins, and
  for verifiers, in that order. The settled license is Apache-2.0.

## The visual badge

Checked Oct 25, 2026 against World's IDKit design guidelines
(updated Oct 5, 2026, docs.world.org/world-id/idkit/design-guidelines):

- World ships an official Human Badge: the World icon plus the word
  "human" in lowercase, in icon-only and icon-plus-label variants,
  with downloadable Figma assets. Its placement table explicitly
  covers messaging/chat (right of username) and social profiles.
  Product instances exist: a small blue badge beside verified
  participants in Zoom, a verified-human badge on Tinder profiles.
- It is a badge for an account that IS a verified human. The brand
  rules forbid removing or replacing the word "human", remixing the
  copy, recoloring or reshaping the logo, or implying privileges the
  badge does not grant.
- No agent-specific badge asset exists in the AgentKit docs (checked
  Oct 25, 2026): AgentKit documents the protocol, hooks, and events,
  no visual mark for a human-backed agent.

Consequences for this project:

- The official badge may appear where it refers to the operator's
  own human verification (for example on the verify page next to the
  operator), used unmodified per the guidelines.
- The agent mark must be this project's own badge, not World's:
  label "fiador", its own symbol, shipped as SVG/PNG assets in
  the repo. Do not put the World logo inside it without World's
  permission; a derivative of their badge would breach the very
  brand rules that make badges trustworthy.
- The proposed badge is dynamic: an image served by the verifier
  for a specific application ID, rendered from a live check with the
  check time shown. A static image can be copied by anyone; a served
  badge copied to a different bot still resolves to the real status
  of the application ID in its URL, and an expired or failed check
  changes what it renders. While application control is unproven,
  a passing wallet claim must use neutral `Claim unconfirmed` art,
  never verified-bot art. The page and `/v/` preview already use
  that neutral state.
- In Discord, a Human-backed role is a guild-admin decision,
  never an automatic stamp from the current verifier. An avatar
  corner overlay is available to operators as decoration only and is
  labelled self-applied wherever the spec mentions it.

## Honest limits (printed in the README, not buried)

- Proves a unique human registered the signing wallet and that
  wallet signed a claim naming a Discord application. It does not
  prove the signer owns or operates that application, that the
  human wrote, read, or approved any bot message, or that the
  bot's runtime is the code the claimant describes. A stolen bot
  token can still pass an old attestation; the attestation
  authenticates a claim, not a running process.
- World ID is anonymous. The proof says "a unique human," never who.
  An operator publicly claiming "this human is me" is a separate
  signed statement from an identity people already know
- AgentBook registrations are public on World Chain. A disclosed
  wallet can reveal its pseudonymous human identifier and other
  wallets registered to the same identifier; anonymity does not
  make those registrations unlinkable.
- Registration is checked live and the verify page shows the
  check time. The current verifier does not certify or update a
  guild role. Admins must review existing role holders manually.
- Adoption is the whole game: an attestation nobody's guild checks
  is a badge on a website. The registry and the reference verifier
  exist to make checking cheaper than not checking

## Test plan (Nic's guild first)

Nic's own guild (niclydon.io, where he is owner and the Nova bot
already operates) is the v1 test bed, same pattern as the muse-discord
community seat trial:

1. Recheck the dedicated demo wallet's AgentBook registration live
   and record the result's date; do not treat an older check as
   proof of its current state.
2. Publish Nova's attestation; verify it with both libraries and the
   static page, including the failure cases (expired, wrong app ID,
   unregistered wallet)
3. Run the verifier bot in Nic's guild: `/attest` checks and logs
   Nova's operator claim but creates no binding or role grant;
   legacy binding rechecks log expiry without a role revocation.
   Observe one sync interval and the startup role-audit warning.
   If draft PR #16 lands, separately test its limited witness
   and confirm it changes no binding or role. Record live evidence
   before describing the guild test as complete.
4. Only then: pitch the community guild's admins an adoption
   decision, with the working demo in Nic's guild as the evidence.
   Their call, their server; nothing is installed there on spec

## Decisions for Nic

- Repo name and license, at creation time (SETTLED Oct 25, 2026:
  Fiador (renamed from human-backed the same day), Apache-2.0, via the World Program coordinator)
- Hosted verifier instance later, or self-host only for v1
  (SETTLED Oct 25, 2026: self-host only for v1, plus the static
  verify page)
- humanId display (SETTLED Oct 25, 2026: hash only; the full
  humanId is never published anywhere, no v1 override)
- Whether Nova's attestation publicly links the human to Nic
  (SETTLED Oct 25, 2026: yes for Nic's own fleet, as an explicit
  operator opt-in field; the protocol default stays name-free)

## Build order

1. Protocol fixtures and verify-ts (the playground's agentkit-core
   lookup code is the seed)
2. Static verify page (usable standalone, demos well)
3. verify-py (parity, fixture-checked against verify-ts)
4. Verifier bot with claim checks, legacy rechecks, audit warnings,
   and no role writes. Application-control proof and any future
   role policy require a separate decision and live test.
5. Registry plus README plus examples
6. Nic's-guild end-to-end test, then the community pitch
