# 2026-10-26 — An application-settings-control experiment

The current Fiador bot can check a wallet's signed claim about a Discord
application. That check does not establish that the wallet holder can change
the application's settings, so the bot still creates no binding or role.

A separate `app-authority-experiment/` prototype now tests a narrower
candidate: the wallet signs a ten-minute challenge naming one exact
application and a unique callback URI; someone with access to that
application's OAuth settings registers the URI; an OAuth code with PKCE is
exchanged without asking for the target bot token or client secret; and
Discord's `/oauth2/@me` must return the same application ID. The callback
requires Discord's issuer and a matching one-use state. Fake Discord HTTP
tests exercise this sequence and its rejection paths. No live Discord app was
changed, no callback was registered, and no production verifier code uses it.

Discord's published authorization-server metadata advertises PKCE S256 and
token-endpoint authentication method `none`, and its Social SDK describes
Public Client exchanges without a secret. Its general HTTP OAuth example
still uses a client secret. A disposable-app live test must establish that
the no-secret HTTP exchange works for this web flow before this candidate
can be treated as real application-settings evidence. Even then, it would be
a dated observation of access or cooperation, not proof of bot runtime,
message authorship, ongoing ownership, or a basis for automatic roles.

The prototype and its prerequisites are documented in
`app-authority-experiment/README.md`.
