# Human-backed Discord bots: public repo spec

Status: DESIGN, Oct 25, 2026. Nic's framing: a public repo so anyone
using World and Discord can attest that their bot or app is backed by a
real human, checkable when the bot is added to a server. Nothing is
built yet beyond the AgentKit playground and agentkit-mcp. Creating the
GitHub repo, and any commit or push, needs Nic's explicit go.

## The integration model (who does what)

Three parties, three jobs. The repo serves all three; no party's part
lives inside another party's code.

- The operator (bot owner) attests: they hold an agent wallet
  registered in AgentBook on World Chain to their Orb-verified World
  ID, and they publish a signed attestation binding that wallet to
  their Discord application.
- The verifier checks: given a Discord application ID, it fetches the
  attestation, verifies the wallet signature, and reads AgentBook live
  to confirm the wallet is registered to a unique human.
- The guild (Discord server) enforces: at bot-join time and on a
  recurring sync, the guild's verifier grants or removes a
  "Human-backed" role and, if the admins choose, gates channels or
  permissions on it. The guild runs no operator code and trusts no
  operator claim that the verifier has not checked.

What does NOT live where:

- Not in muse-discord. muse-discord is one bot framework among many
  (upstream: cszach; Nic's fork: niclydon/muse-discord, private). A
  muse-discord plugin is one optional adapter, later. Baking the
  protocol into one framework would kill the point of a public repo.
- Not with the Discord server owner as a code review. A community
  server's owner or admins make an adoption decision only: invite the
  verifier bot, create the role, set the policy. No PR goes to them.
- Not as a World product. This is independent open source built on
  World's public surfaces (AgentBook contract, agentkit SDK). The
  README must say so plainly, with no implied endorsement.

## The attestation

Canonical signed payload (EIP-191 personal_sign, operator wallet key):

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
   RULE (Nic-direct Oct 25, 2026): the full humanId is never
   published, in this payload or anywhere public. Hash only, no
   operator override in v1. Any agent working from this spec: do
   not place the raw humanId in code fixtures, docs, screenshots,
   logs, or messages outside the estate.

Discovery, the genuinely hard part. A verifier that sees a bot join a
server has only a Discord ID; Discord profiles carry no reliable
custom URL. Two mechanisms, both in scope:

- Registry: a JSON registry (in the public repo, or a hosted copy)
  mapping discord_application_id to attestation_url. Operators add
  themselves by PR or by a submission flow. Simple, auditable, and
  the v1 answer.
- Install-time claim: the operator, who is usually the person adding
  the bot, runs the verifier bot's /attest command in that guild and
  pastes the attestation URL or payload. The verifier checks it,
  records the binding for that guild, and grants the role. No
  registry dependency, works for unlisted bots.

## Repo contents (v1)

- SPEC.md: this protocol, versioned
- packages/verify-ts and packages/verify-py: small libraries exposing
  one function each, verifyAttestation(applicationId or payload) ->
  {valid, wallet, humanHash, expiresAt, failures[]}, with tests
  against recorded fixtures plus a live-chain test flag
- verifier-bot/: a reference Discord bot any guild can self-host (or
  a hosted instance can be offered later). Slash commands:
  /human-backed (status of this server's bots), /verify-agent
  (@bot or application ID), /attest (install-time claim). A role sync
  loop re-checks registrations on an interval and removes the role
  when a check fails or an attestation expires
- verify-page/: a static page that does the whole check client-side
  (signature recovery plus a World Chain RPC read) so a human can
  verify with no server of ours in the loop
- registry/registry.json plus its schema and contribution rules
- examples/: minimal integrations: a raw discord.js bot, a discord.py
  bot, and a static "publish your attestation" walkthrough. The
  muse-discord plugin adapter is a v2 example, not v1
- README.md written for a stranger: what this proves, what it does
  not prove (below), quickstart for operators, for guild admins, and
  for verifiers, in that order. License: MIT or Apache-2.0, matching
  World's own open source posture; Nic picks at repo creation

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
  label "human-backed", its own symbol, shipped as SVG/PNG assets in
  the repo. Do not put the World logo inside it without World's
  permission; a derivative of their badge would breach the very
  brand rules that make badges trustworthy.
- The badge that matters is dynamic: an image served by the verifier
  for a specific application ID, rendered from a live check with the
  check time shown. A static image can be copied by anyone; a served
  badge copied to a different bot still resolves to the real status
  of the application ID in its URL, and an expired or failed check
  changes what it renders.
- In Discord the granted role is the in-app visual stamp. An avatar
  corner overlay is available to operators as decoration only and is
  labelled self-applied wherever the spec mentions it.

## Honest limits (printed in the README, not buried)

- Proves a unique human backs the operator's wallet registration. It
  does not prove the human wrote, read, or approved any given bot
  message, and it does not prove the bot's current runtime is the
  code the operator claims (a stolen bot token still passes an old
  attestation; the attestation authenticates the operator's claim,
  not the process)
- World ID is anonymous. The proof says "a unique human," never who.
  An operator publicly claiming "this human is me" is a separate
  signed statement from an identity people already know
- Registration is checked live, but between sync intervals a role is
  only as fresh as the last check; the verify page always shows the
  check time
- Adoption is the whole game: an attestation nobody's guild checks
  is a badge on a website. The registry and the reference verifier
  exist to make checking cheaper than not checking

## Test plan (Nic's guild first)

Nic's own guild (niclydon.io, where he is owner and the Nova bot
already operates) is the v1 test bed, same pattern as the muse-discord
community seat trial:

1. Nova's playground wallet completes AgentBook registration (needs
   Nic's Orb verification, the standing wall from the fleet spec)
2. Publish Nova's attestation; verify it with both libraries and the
   static page, including the failure cases (expired, wrong app ID,
   unregistered wallet)
3. Run the verifier bot in Nic's guild: /attest flow, role granted,
   role removed on a deliberately expired attestation, sync loop
   observed across one interval
4. Only then: pitch the community guild's admins an adoption
   decision, with the working demo in Nic's guild as the evidence.
   Their call, their server; nothing is installed there on spec

## Decisions for Nic

- Repo name and license, at creation time (SETTLED Oct 25, 2026:
  human-backed, Apache-2.0, via the World Program coordinator)
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
4. Verifier bot with role sync
5. Registry plus README plus examples
6. Nic's-guild end-to-end test, then the community pitch
