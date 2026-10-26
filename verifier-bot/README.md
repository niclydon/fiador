# Fiador verifier bot

The reference verifier bot for **Fiador — human-backed attestation for
Discord bots**. This is a self-host package: each adopting server runs its
own instance, under its own Discord application and bot token, on
infrastructure it controls (DESIGN §5). There is no central bot to invite
and no project-run hosted instance in v1. A guild that wants the role
without running anything can use the static verify page and grant the
role by hand; this bot is what self-hosting buys on top: automation.

## What it does

A bot operator publishes a signed attestation binding their Discord
application to a wallet registered in AgentBook (World Chain). This bot:

- verifies attestations through the `@fiador/verify` core — signature,
  expiry, subject binding, and a live AgentBook lookup;
- binds verified applications to the guild (`/attest`, or discovery via
  the registry);
- grants the guild's **Human-backed** role to bots whose attestation
  currently verifies, and keeps it in sync (default every 6 hours).

Fiador verifies *operator* attestations: the claim being checked is
"a unique human backs the operator of this bot application". It does not
run World ID proofs for individual users, and it never sees a raw
humanId — public results carry the humanId hash only, and the hashes and
wallet addresses shown in Discord are truncated.

## The Human-backed role

- The role is named exactly `Human-backed` by default. Guilds may rename
  it; the bot tracks it by role ID, never by name.
- Sync semantics (DESIGN §5.5) are deliberately asymmetric:
  - `verified` → grant.
  - `invalid`, `expired`, `unregistered` → revoke, with the failure
    sentence in the audit reason and the log channel.
  - `unknown` → **keep, always**. `unknown` means the check itself
    failed (RPC down, lookup timed out). It revokes nothing: the binding
    retries once after 15 minutes, and a second consecutive `unknown`
    posts a log-channel warning instead of a revocation. Chain
    unavailability is our problem; a lapsed attestation is the
    operator's. This only works because the verify core keeps `unknown`
    distinct from `unregistered` instead of collapsing both to "no".

## Commands

All responses are ephemeral.

| Command | Who | What |
| --- | --- | --- |
| `/fiador status` | anyone | Bound bots, each one's last check result and time, role member count |
| `/fiador setup` | Manage Guild | Set the Human-backed role ID, registry URL, sync interval, log channel |
| `/verify-agent <application_id>` | anyone | One-off check of one application; no state change |
| `/attest <url \| attestation>` | anyone | Verify a presented attestation; on success, bind it and apply the role decision. On failure, report the failure sentence and store nothing |

Anyone may run `/attest` — the cryptography, not the caller, is the
gate — but role changes only ever follow a passing verify. `/attest` is
rate-limited to 5 attempts per user per guild per 10 minutes.

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

Per guild: create (or pick) the `Human-backed` role, make sure this
bot's own role sits **above** it in the hierarchy and holds Manage
Roles, then run `/fiador setup` with the role ID. Invite permissions
needed: Manage Roles + Slash Commands. Intents: Guilds + GuildMembers —
no message-content intent; this bot reads no messages.

## Run

```sh
# from the repo root, once: npm install
npm run build --workspace=@fiador/verify   # the core must be built first
npm run build --workspace=@fiador/verifier-bot
DISCORD_TOKEN=… DISCORD_CLIENT_ID=… npm start --workspace=@fiador/verifier-bot
```

State lives in one SQLite file (Node's built-in `node:sqlite`): guild
config, bindings, and an append-only `check_log` (status stored verbatim,
prunable by age) so a self-hoster can answer "when did this role last
verify?".

## Safety properties

- Every operator-influenced URL is fetched through an SSRF guard
  (`src/fetchGuard.ts`): HTTPS only, DNS results vetted against
  loopback/RFC1918/link-local/metadata ranges (literal IPs too),
  redirects re-vetted and capped at 3, 5s timeout, 256 KiB body cap,
  JSON only.
- Startup prints only the bot's own user ID and guild count.

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
- **Bot-user resolution**: `resolveBotUserId` in the real adapter is a
  scaffold-level lookup (bound `botUserId` from the signed payload's
  `extra.discord_bot_user_id` is preferred and is what the tests use);
  hardening application→user resolution against the live API is future
  work.
- **Scheduler**: one jittered interval timer drives full-guild syncs
  using the smallest configured interval; per-binding cadence refinement
  is future work. A full re-check runs at startup.

## Pattern provenance

Informed by the proven `world-id-discord` fork (guild configuration
storage shape, role-assignment plumbing, and defensive error handling
around Discord API calls). **Not** carried over: that bot's IDKit
user-proof flow — Fiador verifies operator attestations, a different
claim, through a different protocol. Everything attestation-shaped here
(payload handling, hash-only display, sync asymmetry) is new and follows
`docs/DESIGN.md` §5 and `docs/SPEC.md`.
