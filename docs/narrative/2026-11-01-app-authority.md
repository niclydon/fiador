# Application-authority ceremony — 2026-11-01

The bot-response witness (Oct 27, 2026) proved a wallet signed a fresh
challenge and the named bot answered. It never proved the signer holds
authority over the Discord application, and until something did, Fiador's
claim state stayed "Claim unconfirmed", with bindings, badge promotion,
and role automation all held off. This arc built that missing proof.

## How the design settled

Two candidate primitives were on the table. The W1 draft spec
(Oct 28, 2026) proposed a server-side OAuth2 exchange using the target
application's client secret, presented to the verifier by the operator's
backend. The `app-authority-experiment/` subtree, built by another lane
and already on `main`, proposed the opposite: a PKCE exchange with no
secret at all, where the authority evidence is a per-session callback URI
registered in the target application's OAuth settings.

The PKCE design won on two facts verified live before any code was
written:

- On Oct 31, 2026, a bot-token `PATCH /applications/@me` against the
  Fiador application set `redirect_uris` — and was silently ignored
  (read back unchanged, array still empty). Redirect URI registration
  is Developer Portal work, so it is owner/team-grade evidence, not
  token-grade. The same probe class had earlier shown the URL fields
  and the Public Bot toggle are also portal-only.
- Discord's authorization-server metadata advertises token-endpoint
  auth method `none` and S256 PKCE, and redirected OAuth responses
  carry the `iss` parameter (Discord change log, Oct 14, 2026) — the
  exact checks the experiment's `complete()` already performed.

The full protocol is specified in `docs/app-authority.md`, which
supersedes the Oct 28 draft. The honest claim is unchanged from the
draft: application authority, team-grade. A cooperating administrator
could register the URI for a wallet holder with no authority of their
own; the ceremony proves fresh cooperation between the wallet and the
application's authority, and the spec says so plainly.

## What was built

- `verifier-bot/src/appAuthority.ts` — the ceremony service, adapted
  from the experiment into the bot's seams: the witness's attestation
  gates at start (verified attestation, current published claim,
  exactly one enabled guild integration), the shared contract-wallet
  signature verifier, and an injected Discord transport so tests never
  touch the network.
- Store support (`verifier-bot/src/store.ts`): `authority_session`
  rows hold the OAuth state and PKCE verifier, scrubbed in the same
  atomic update that consumes the session; `authority_record` rows
  hold completed proofs keyed to the attestation payload hash. The
  sign and consume transitions are single guarded UPDATEs, so exactly
  one completion wins across processes — the same pattern the witness
  uses, with tests mirroring its cross-connection case.
- Three Manage-Guild commands (`authority-start`, `authority-sign`,
  `authority-complete`) alongside the witness pair. The operator
  pastes back exactly one artifact — the full callback URL from their
  browser's address bar — and the verifier performs the exchange and
  the `GET /oauth2/@me` read itself. The access token is never stored,
  logged, or returned.
- `/fiador status` reports a current authority record where one
  exists; without one, lines read exactly as before.
- Configuration is opt-in per instance: `AUTHORITY_CALLBACK_ORIGIN`
  must be one exact HTTPS origin, validated at startup. Unconfigured
  instances report the ceremony unavailable.
- A static callback helper page (`verify-page/app-authority-callback.html`)
  explains the final step; it transmits nothing. `scripts/build-web.mjs`
  copies it into the web build, and `vercel.json` rewrites
  `/app-authority/callback/<proof ID>` to it. Its production promotion
  is a separate operator-approved deploy and has not happened.

Seventeen new tests cover the happy path, wrong-wallet signatures,
replay, wrong state (ceremony survives; the code can still be used),
wrong issuer, expiry, a token minted for another application (ceremony
burned, fail closed), missing `identify` scope, a non-snowflake
authorizing user, mid-ceremony attestation drift (aborts before
consuming), guild binding, callback-URL strictness, origin validation,
and the store's sign/consume semantics. Full verifier-bot suite:
89 tests, all green; typecheck clean.

## What did not change

A completed ceremony creates no binding, renders no new badge state,
and grants no role. Role automation stays disabled; keying any of
those off authority records is a separate policy change with its own
review. The witness's trust boundary is untouched.

## What remains

The first live ceremony needs the application admin at the Developer
Portal — register the session's callback URI on the target application
and authorize — plus the callback page promoted to production so the
redirect lands on the helper rather than a 404. That is a short joint
session by design, and it is the §9-style end-to-end proof this build
is ready for.
