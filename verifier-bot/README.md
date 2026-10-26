# Fiador verifier bot

The reference verifier bot for **Fiador — human-backed attestation for
Discord bots**. This is a self-host package: each adopting server runs its
own instance, under its own Discord application and bot token, on
infrastructure it controls (DESIGN §5). There is no central bot to invite
and no project-run hosted instance in v1. Application-operator control proof is
not implemented, so this package is currently a check-and-log scaffold;
guilds must decide any Human-backed role assignment manually.

## What it does

A bot operator publishes a signed attestation binding their Discord
application to a wallet registered in AgentBook (World Chain). This bot:

- verifies attestations through the `@fiador/verify` core — signature,
  expiry, subject binding, and a live AgentBook lookup;
- checks a presented attestation with `/attest` and logs the result;
- records a limited one-use wallet signature and bot-response witness;
- checks previously stored bindings on a timer, without changing roles.

A passing attestation proves that a registered wallet signed a claim
*about* an application. It does not prove the wallet controls that
application. This bot does not treat a claimed application ID, the
signed `extra.discord_bot_user_id`, a registry entry, or a guild member's
`bot` flag as application-control evidence. `/attest` therefore creates
no new binding and grants no role, even when the operator proof passes.
The neutral result embed states this explicitly.

Fiador verifies *operator* attestations: the claim being checked is
"a unique human backs the operator of this bot application". It does not
run World ID proofs for individual users. It never displays or stores a
raw humanId: public results carry the humanId hash only, and the hashes
and wallet addresses in public check results are truncated. The ephemeral
wallet-signature text includes the full signing wallet address; the separate
public bot message contains only the verifier mention and a random nonce.

## The Human-backed role

- The role is named exactly `Human-backed` by default. Guilds may rename
  it; the bot tracks it by role ID, never by name.
- **All** check statuses currently keep the existing role state.
  This includes `verified`, because application control is unproven,
  and `invalid`/`expired`/`unregistered`, because a legacy binding's
  self-asserted bot ID is unsafe to use for revocation. Check existing
  Human-backed role holders manually when upgrading this package.
- On startup, a guild with a configured role or stored legacy claims
  gets an `ADMIN AUDIT REQUIRED` warning in the process log and, when
  configured, its log channel.
  This is an instruction to compare the actual role holders with trusted
  application-control evidence and remove unsupported roles manually.
  It does not change roles. Run `/fiador status` to see stored claims;
  use `page` for additional rows. An admin must inspect the actual role
  holders in Discord because the bot does not have a complete count.
- `unknown` still retries once after 15 minutes and warns in the log
  channel after a second failed check. It never changes a role.

## Commands

All responses are ephemeral.

| Command | Who | What |
| --- | --- | --- |
| `/fiador status [page]` | anyone | Six legacy claims per page, last operator checks, manual role-audit warning |
| `/fiador setup` | Manage Guild | Set the Human-backed role ID, registry URL, sync interval, log channel |
| `/fiador control-start <url>` | Manage Guild | Start a ten-minute wallet and bot-response witness in this channel |
| `/fiador control-complete <nonce> <signature> <message_id>` | Manage Guild | Record a limited witness; no binding or role change |
| `/verify-agent <application_id>` | anyone | One-off check of one application; logs the check but changes no binding or role |
| `/attest <url \| attestation>` | anyone | Check a presented operator attestation and log the result; never bind or change a role |

Anyone may run `/attest` or `/verify-agent`; neither can grant a role.
They share a limit of 5 checks per user per guild per 10 minutes. The two
control commands share a separate per-user, per-guild limit.

## Bot-response witness

1. Publish a signed Discord attestation with a hash-only profile, including
   `human_id_hash`, `discord_bot_user_id`, the application subject ID, and
   its exact HTTPS `attestationUrl`.
2. A member with Manage Guild runs `/fiador control-start url:<URL>` in a
   channel belonging to the verifier's guild.
3. Sign the **private wallet-signature text** with the attestation wallet
   as an EIP-191 personal message. Do not post it. Have the named bot post
   only the separate **public bot-response text** in the same channel, then
   copy the bot message ID. The public text includes a random nonce and
   mentions the verifier bot so Discord can reveal its content without a
   privileged Message Content intent. It does not include the wallet,
   attestation hash or URL, application ID, or bot ID.
4. Run `/fiador control-complete` with the nonce, wallet signature, and
   message ID before the ten-minute deadline.

The verifier uses only its **own** bot token. It needs `MANAGE_GUILD` in
that guild to read integrations, and `VIEW_CHANNEL` plus
`READ_MESSAGE_HISTORY` in the challenge channel to fetch one message by
ID. It never scans channel history or subscribes to message events. The
target bot token is never requested or stored. Discord caps its integration
list at 50, so a list of 50 fails closed. Exactly one enabled
`type=discord` integration must have the claimed `application.id` and
`application.bot.id`; an omitted bot field fails.

The private signature text binds the full wallet, signed payload hash,
application and bot IDs, guild and channel IDs, verifier ID, nonce, and
deadline. The nonce links it to the public bot response without publishing
those identifiers in the bot's message. Completion repeats the attestation
and live AgentBook check, recomputes the signed payload hash, checks registry
revocation, verifies the wallet
signature on World Chain, checks the channel's guild, fetches the exact
fresh DEFAULT bot message, and rereads the integration before atomically
consuming the nonce. Webhook, edited, forwarded, crossposted, and
interaction messages are rejected. Failed checks leave the nonce unused.

**This records a bot response, not application-operator control.** A bot
that echoes arbitrary user input can emit a matching message without its
operator authorizing the claim. The witness never creates or upgrades a
binding, never changes the public `claim_unconfirmed` state, and never
grants or revokes a role. Independent operator authority is still needed.

The SQLite row retains the wallet address, app and bot IDs, attestation
URL and payload hash, nonce, timestamps, and successful message ID. It
does not retain the wallet signature, bot token, message body, or raw human
ID. Expired rows more than 24 hours old are pruned at startup and daily.

## Configuration

Environment only; the token is never written to disk or the database.

| Variable | Required | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token for *your own* Discord application |
| `DISCORD_CLIENT_ID` | yes | That application's ID (for command registration) |
| `REGISTRY_URL` | no | Default attestation registry URL (per-guild setup can override) |
| `RPC_URL` | no | World Chain RPC URL (package default otherwise) |
| `DB_PATH` | no | SQLite state file (default `./data/fiador-verifier.db`) |
| `SYNC_INTERVAL_MINUTES` | no | Default sync interval (default 360 = 6h) |

Per guild, an admin may record the `Human-backed` role ID with
`/fiador setup` for status display. Role automation is disabled; the
bot currently needs no Manage Roles permission. Its configured intents
are Guilds + GuildMembers, with no message-content intent.

## Run

Requires Node.js 22.13 or newer for the unflagged `node:sqlite` module.

```sh
# from the repo root, once: npm install
npm run build --workspace=@fiador/verify   # the core must be built first
npm run build --workspace=@fiador/verifier-bot
DISCORD_TOKEN=… DISCORD_CLIENT_ID=… npm start --workspace=@fiador/verifier-bot
```

State lives in one SQLite file (Node's built-in `node:sqlite`): guild
config, legacy bindings, short-lived witness rows, and a `check_log`
(status stored verbatim, pruned on startup and daily after 90 days) so a
self-hoster can answer "when was this operator claim last checked?".

## Safety properties

- Every operator-influenced URL is fetched through an SSRF guard
  (`src/fetchGuard.ts`): HTTPS only, DNS results vetted against
  loopback/RFC1918/link-local/metadata ranges (literal IPs too),
  connection pinned to a vetted address with TLS hostname validation,
  no redirects, 5s total timeout, 64 KiB body cap, JSON only.
- Startup logs the bot's own user ID and guild count. Guilds with a
  configured role or stored legacy claims also get a role-audit warning
  with the guild ID and claim count. The token, wallet IDs, and
  attestation URLs are not logged.
- A passing operator attestation never produces a verified bot badge,
  a new binding, or a role write. Existing bindings are checked but
  cannot cause grants or revocations.

## Application-control gate

The remaining proof must bind the attestation signer to **operator
authority** over the specific Discord application and its bot user. A
fresh bot-authored message alone does not do this. Discord's
documented [`GET /oauth2/applications/@me`](https://docs.discord.com/developers/topics/oauth2#bot-users)
returns the current application only when authenticated with that
application's bot token. This self-hosted verifier possesses only its
own token and should never ask another operator to hand over theirs.
Discord's [user object](https://docs.discord.com/developers/resources/user#user-object)
offers a `bot` boolean, but that flag does not prove who controls the
application. No supported cross-application operator-control assertion is
wired here. A future protocol must prove wallet authority without
disclosing target bot credentials to the verifier. Until then, role
automation remains disabled.

## Stub boundaries

This package is a scaffold built against the verify core's specified
interface (W0 spec §3 / DESIGN §4.1):

- **Verify core**: consumed via `@fiador/verify`. Tests substitute a
  fake `createVerifier` (vitest alias → `tests/fakeVerify.ts`) with
  programmable statuses; the fake re-exports the *real*
  `toPublicVerifyResult`/`hashHumanId` from the core's types module, so
  the hash-only projection is tested as production code. No test makes
  a network call or performs a real AgentBook lookup.
- **Discord**: all side effects go through `src/discordAdapter.ts`.
  Only `src/index.ts` imports discord.js; tests use a fake adapter, no
  token, no live Discord.
- **Bot-response witness**: local tests cover integration and message
  validation, durable one-use storage, expiry, concurrency, and outages.
  No live Discord witness has been run.
- **Application control**: no operator-authority provider or live proof
  exists. The role gate is deliberately closed.
- **Scheduler**: startup checks run independently across guilds, with up
  to four guild checks in flight. Each guild's next check is scheduled
  from its own configured interval with ±10% jitter; a local timer also
  looks for new guilds and setup changes every 30 seconds. Per-binding
  cadence refinement is future work.

## Pattern provenance

Informed by the `world-id-discord` fork (guild configuration storage
shape and defensive error handling around Discord API calls). **Not**
carried over: that bot's IDKit
user-proof flow — Fiador verifies operator attestations, a different
claim, through a different protocol. Everything attestation-shaped here
(payload handling and hash-only display) is new. Role automation
described in `docs/DESIGN.md` §5 is deferred until application control
is independently proven.
