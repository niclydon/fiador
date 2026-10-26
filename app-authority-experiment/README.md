# Application settings-control experiment

This is an isolated, local-only protocol exercise. Fiador's verifier bot,
public page, registry, and role gate do not import it. The code accepts an
injected Discord transport and has no HTTP listener, persistent store, or
deployment configuration. `npm test` uses only synthetic wallets and fake
Discord responses; it does not contact Discord.

## Question tested

Can a signing wallet demonstrate fresh ability to change the OAuth settings
of one exact Discord application without giving Fiador that application's
bot token or client secret?

1. Fiador creates a ten-minute challenge containing a random nonce, the
   wallet, exact Discord application ID, and a unique HTTPS callback URI.
   The wallet signs the whole message with EIP-191. The callback URI must be
   registered in that application's OAuth settings by someone with access to
   those settings.
2. The experiment starts an authorization-code flow for that **target**
   application, with a random `state`, PKCE S256, and only `identify` scope.
   No bot-install or command scope is requested.
3. On the exact callback URI, it requires the original `state` and Discord's
   exact `iss=https://discord.com` before it sends the code to Discord's
   pinned token endpoint. The form includes `client_id`, the exact callback
   URI, and `code_verifier`; it never includes a client secret.
4. It queries Discord's pinned `GET /oauth2/@me` endpoint with the returned
   bearer token and requires the response's `application.id` to equal the
   challenged application ID. The challenge is consumed before exchange, even
   if the exchange fails. Access and refresh tokens are not returned or saved.

The return value says `local_experiment_passed` only. It is not a public
verified claim, application-to-bot-user proof, role decision, or standing
ownership certificate. No role write exists in this subtree.

## What the official sources support

- Discord's [OAuth2 reference](https://docs.discord.com/developers/topics/oauth2)
  documents `state`, authorization-code redirects, exact registered redirect
  URIs, `GET /oauth2/@me`, and the `iss` value. The [October 14, 2026 change
  log](https://docs.discord.com/developers/change-log#october-14-2026)
  says redirected OAuth responses now include that issuer parameter.
- Discord's [authorization-server metadata](https://discord.com/.well-known/oauth-authorization-server)
  advertises `S256`, `authorization_response_iss_parameter_supported`, and
  token-endpoint authentication method `none`.
- Discord's [Social SDK reference](https://discord.com/developers/docs/social-sdk/classdiscordpp_1_1Client.html)
  describes a Public Client setting and a secret-free PKCE exchange through
  `Client::GetToken`. The general OAuth2 HTTP example still shows a client
  secret. **A no-secret HTTP exchange for this exact web flow has not been
  live-tested.** Metadata and SDK documentation are not a substitute for that
  test.

## Conditions before any integration

- Use a newly created, disposable Discord application that the tester owns.
  Confirm that its Public Client setting allows a no-secret HTTP code exchange
  using a freshly registered exact callback URI. Do not collect or inspect its
  bot token or client secret. Remove the temporary callback afterward.
- Confirm Discord rejects an unregistered URI and a URI registered to a
  different application, and that `GET /oauth2/@me` returns the target ID.
  Check that authorization uses only the requested scope and no bot install.
- Replace in-memory sessions with an atomic, expiring store shared by every
  callback worker. Add a real HTTPS callback listener, strict origin routing,
  streaming response limits, short network timeouts, redacted request logs,
  and a reviewed token disposal or revocation policy. Keep authorization codes,
  bearer tokens, wallet signatures, and nonce values out of logs.
- Independently resolve the app-to-bot-user mapping and decide the meaning of
  control over time. A cooperating app administrator could register a URI for
  a wallet holder, and control can later be revoked or transferred. This
  experiment would at most show fresh cooperation with app settings.
- Review the complete role policy and its failure/revocation behavior before
  changing Fiador's current no-role-write gate.

For local verification: `npm ci --ignore-scripts && npm test` in this
directory. No live credentials, real app ID, or network access are needed.
