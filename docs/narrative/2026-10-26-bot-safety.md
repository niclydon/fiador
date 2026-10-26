# 2026-10-26 — The verifier bot's claim boundary

The first build described a role sync loop. Review of the actual
claim proved a stricter boundary was necessary: a wallet holder can
sign an otherwise valid attestation naming an application they do
not control. Fiador now treats that result as an operator claim to
check and log. The bot creates no new binding and grants or revokes
no role. A guild admin needs separate application-control evidence
before deciding what to do with existing role holders.

The same review found that a configured audit-channel ID could be
resolved outside the guild that produced the check. The bot now
confirms the fetched channel belongs to the originating guild before
sending a line. Tests cover a channel in the right guild, another
guild, a DM, a non-text channel, and a missing channel.

The maintenance pass closed three operational gaps in the bot. Both
public check commands now share a five-check budget per user and
guild over ten minutes. Check-log rows older than 90 days are pruned
at startup and daily. Each guild has its own periodic schedule,
with jitter, one active check per guild, and at most four guilds
checking at once. Startup checks follow the same independent path.
The bot README describes these behaviors and the claim boundary.

The maintenance branch passed build and typecheck locally. Its test
run passed 51 bot tests, 36 core tests, and two web tests; three core
fixture tests were skipped. GitHub CI passed on Node 22 and 24 at
the reviewed head. Independent correctness and security reviews
reported no blockers before merge.

This is code and test evidence, not live Discord verification. The
dedicated verifier-bot witness remains a draft; it does not yet
establish control of an application. Registry and RPC caching and a
live multi-guild check remain open. Until application control is
proved and the role policy is reviewed, a passing claim cannot
trigger a role change.
