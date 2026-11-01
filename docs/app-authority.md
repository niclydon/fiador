# Application-authority ceremony — protocol spec

Status: built in the reference verifier bot (`verifier-bot/src/appAuthority.ts`),
November 1, 2026. Supersedes the W1 draft spec of October 28, 2026, whose
client-secret exchange design was replaced by the PKCE design below after
the decisive platform facts were verified live (see "Why this primitive").

## The gap this closes

A Fiador attestation proves a wallet registered to a unique human signed a
claim about a Discord application. The bot-response witness (DESIGN §5.2)
proves the named bot answered a fresh challenge. Neither proves the signer
holds authority over the application itself:

- A bot token proves token possession. A leaked token would pass any
  token-based check.
- A bot can echo arbitrary text, so a response proves responsiveness, not
  authority.

Until authority is proven, the verifier creates no bindings, the badge
stays at "Claim unconfirmed", and role automation stays off. This ceremony
is the missing proof.

## The claim it supports

Application authority, team-grade: the attestation wallet's holder and a
Discord account with authority over the application took part in one fresh
ceremony. It does **not** prove sole legal ownership of the application,
and public copy must not say it does. It does not prove message authorship
or runtime identity; those limits are unchanged from DESIGN §1.

## Why this primitive

Discord OAuth2, run through the target application itself, with a PKCE
(S256) exchange and no client secret anywhere in the flow. The authority
evidence is the redirect URI: the verifier mints a session whose callback
URI is unique to that session, and Discord will only redirect to a URI
registered in the target application's OAuth settings.

Platform facts, verified live:

- Redirect URIs are **not** writable with a bot token. On October 31, 2026,
  a bot-token `PATCH /applications/@me` setting `redirect_uris` on the
  Fiador application was accepted and silently ignored (read back
  unchanged). Registering a URI requires Developer Portal access, which
  only the application's owner or team has.
- Discord's authorization-server metadata
  (`https://discord.com/.well-known/oauth-authorization-server`, read
  November 1, 2026) advertises `token_endpoint_auth_methods_supported`
  including `none`, `code_challenge_methods_supported: ["S256"]`, and
  `authorization_response_iss_parameter_supported: true`. Redirected OAuth
  responses carry `iss=https://discord.com` (Discord change log,
  October 14, 2026).
- `GET /oauth2/@me` for an authorization-code token reports the
  application the token was minted through and the authorizing user.

Rejected alternatives:

- Client-secret server-side exchange (the October 28 draft): sound, but it
  makes the operator's backend a ceremony participant and moves a secret
  through the flow for no additional evidence. The registered-URI fact is
  the same portal authority, proven fresher (per-session URI).
- Bot-token reads of `/applications/@me`: token-grade.
- Nonces in the application description or other portal fields: those
  fields are writable with the bot token (this project set its app icon by
  API), so they are token-grade too.

One honest limitation: a cooperating application administrator could
register the ceremony URI for a wallet holder who has no authority of
their own. The ceremony proves fresh cooperation between the wallet and
the application's authority; it cannot distinguish "the same person" from
"two people cooperating". That is exactly the team-grade claim above.

## Flow

All steps run through three Manage-Guild slash commands on the verifier
bot. The session lasts ten minutes, is one-use, and fails closed.

1. `/fiador authority-start url:<attestation URL>` — the verifier runs the
   same gates as the bot-response witness (attestation verifies, published
   claim is current, the guild has exactly one enabled Discord integration
   for the application), then mints a session: a random proof ID, nonce,
   OAuth `state`, and PKCE verifier, stored in the bot's own SQLite state.
   The callback URI is `<callback origin>/app-authority/callback/<proof ID>`.
   The reply shows the callback URI and the exact statement to sign.
2. The operator registers the callback URI in the target application's
   Developer Portal OAuth settings (the authority-bearing act), and signs
   the statement with the attestation wallet.
3. `/fiador authority-sign proof_id:<id> signature:<sig>` — the verifier
   checks the signature recovers the attestation wallet (contract wallets
   included, via the same verifier seam as the witness), marks the session
   signed atomically, and replies with the Discord authorization URL
   (`response_type=code`, `scope=identify`, the session `state`, and the
   S256 challenge of the stored PKCE verifier, `prompt=consent`).
4. The application's owner or a team member opens the URL and authorizes.
   Discord redirects the browser to the callback URI with `code`, `state`,
   and `iss` parameters. The callback page is a static helper that shows
   the operator their full callback URL; nothing on the page transmits it.
5. `/fiador authority-complete proof_id:<id> callback_url:<full URL>` —
   the verifier parses the pasted URL strictly (exact origin and path,
   exactly the three expected parameters, `iss` equal to
   `https://discord.com`), checks `state` against the session in constant
   time, re-verifies the attestation and the currency of the published
   claim, then consumes the session atomically **before** exchanging the
   code, so a failed exchange still burns the ceremony. It exchanges the
   code itself (PKCE verifier, no secret), reads `GET /oauth2/@me` once,
   and requires the returned application ID to equal the challenged
   application and the granted scopes to include `identify`. The access
   token is never stored, logged, or returned; any refresh token is
   ignored.
6. On success the verifier saves an **authority record**: guild,
   application, wallet, the authorizing Discord user ID, the attestation
   payload hash, and the proof time. The record is current only for that
   exact payload hash; re-issuing the attestation requires a fresh
   ceremony.

## Deployment shape

- The ceremony is optional per verifier instance. It activates when the
  operator sets `AUTHORITY_CALLBACK_ORIGIN` to the exact HTTPS origin
  serving the callback helper page (`verify-page/app-authority-callback.html`,
  routed from `/app-authority/callback/<proof ID>` by the host's rewrite
  rules). Without it, the authority commands report themselves unavailable,
  like the witness does when unconfigured.
- Sessions and records live in the same local SQLite state file as the
  rest of the bot (DESIGN §5.1). Session secrets (OAuth state, PKCE
  verifier) are scrubbed from the row when the session is consumed;
  expired sessions are pruned daily.
- No new network listener is added to the bot, and no token, code, or
  signature is ever logged.

## Threats considered

- Leaked bot token: worthless here. It cannot register a redirect URI,
  cannot sign for the wallet, and cannot authorize as the owner.
- Leaked client secret: never used, so never in scope.
- Replay: sessions and codes are one-use; the session is consumed before
  the exchange, and the atomic consume admits exactly one completion.
- Code interception: a stolen code is useless without the PKCE verifier,
  which never leaves the verifier's state store, and without the session
  `state` matching.
- Phishing: the OAuth client in the ceremony is the operator's own
  application and the consent screen names it; the start reply names the
  application the ceremony is for. Authorizing a foreign client is out of
  scope.
- Backend compromise: out of scope, identical to bot-token compromise
  today, and it still yields neither the wallet key nor portal access.

## What a current authority record unlocks, and what it does not

- The verifier may treat the application as authority-proven for the
  current attestation: `/fiador status` reports the proof and its date.
- Bindings, badge state, and role automation **may** key off a current
  record, but enabling any of them is a separate policy change with its
  own review. This build changes none of them: no binding is created, the
  badge still renders "Claim unconfirmed", and role automation stays off.

## Remaining live step

Unit and integration tests cover the full ceremony against a fake Discord
transport (happy path plus every failure path above). The first live
ceremony against a real application additionally needs the application's
admin at the Developer Portal to register the callback URI and authorize,
which is a short joint session by design.
