# Fiador badge service

The dynamic badge service from the W0 verify core spec (section 4):
a stateless HTTP service whose only job is to resolve a subject,
run `@fiador/verify` at request time, and render the project's
badge for the observed state. A static badge is a claim anyone can
copy; a served badge names its subject in its URL and reports the
latest checked status within its stated cache window. A passing
wallet check for a Discord application still does not establish
control of that application. Until an independent control gate
exists, its badge says `Claim unconfirmed` in neutral artwork.

Framework choice, in one line as the spec's build-choice clause
asks: plain Node HTTP (`node:http`), no framework — the routes and
headers are the spec, and a keyless read-only service should carry
the smallest dependency surface that serves it. PNG rendering uses
`@resvg/resvg-js` (pinned): it rasterises the exact SVG the `.svg`
route serves, so PNG palette and layout parity is by construction,
with no native build step and no second layout engine.

This is a top-level application in the Fiador repo, not an npm
workspace package. It consumes `@fiador/verify` only through the
package's public `exports` entry point (the spec's one-way
dependency rule) and renders from the returned status only; the
JSON route's status comes from the core, never from the render
layer.

## Run it

```sh
# from the repo root, once: the core must be built first
npm install && npm run build -w @fiador/verify

cd badge-service
npm install
npm run build
npm start            # listens on BADGE_HOST:PORT (default 127.0.0.1:8788)
npm test             # route-level suite (fake verifier + resolver)
```

Nothing is deployed by this package and v1 operates no project-run
public instance: this is code any operator or guild can self-host.

## Routes

| Route | Returns |
|---|---|
| `GET /badge/:subjectType/:subjectId.svg` | badge SVG for the live state |
| `GET /badge/:subjectType/:subjectId.png` | same badge as PNG, rasterised at 3x |
| `GET /v1/status/:subjectType/:subjectId` | public JSON status plus badge URLs |
| `GET /health` | `{ ok, agentBookReachable, lastLookupMs }`, no subject data |
| `GET /` | explainer page: what the badge means, with live examples |

`subjectType` in v1 is `discord_application` and `address` (a raw
wallet). The legacy alias `GET /badge/<discord_application_id>.svg`
is accepted as sugar; documentation leads with the typed route.
Path parameters are URL-encoded.

Query parameters on the badge routes:

- `theme=auto|dark|light`, default `auto`. Both palettes always
  exist; the parameter only selects. `theme=auto` on SVG returns
  one file carrying both palettes, switching inside the file via a
  `@media (prefers-color-scheme: dark)` block with the light
  palette as the in-file fallback. `theme=auto` on PNG resolves
  server-side from the `Sec-CH-Prefers-Color-Scheme` client hint,
  falls back to `dark` when the hint is absent, and reports the
  resolution in the `X-Badge-Theme` header (with
  `Vary: Sec-CH-Prefers-Color-Scheme`, so a shared cache can never
  hand a dark-resolved PNG to a light-context viewer).
- `variant=pill|icon`, default `pill`. The icon carries no label
  or timestamp text; the pill is the canonical embed and the icon
  is the weaker claim.
- `format` is never a query parameter; the extension decides.

For HTML pages prefer a `<picture>` element with
`media="(prefers-color-scheme: dark)"` selecting `theme=dark` and
the default `theme=light`; for Markdown use the `auto` SVG. The
explainer page at `/` shows both patterns with copy-paste
snippets, ships in light and dark (first visit follows
`prefers-color-scheme`, the toggle persists), and its examples are
live badges from this service.

## States

Rendered states are the badge set's, exactly: `verified`,
`expired`, `unverified`, in both themes and both variants, from
the canonical palette tables in `assets/badges/` (ported into
`src/palettes.ts`; the tests fail if the renderer's colours drift
from them). For an `address` subject, the core's status maps as:
`verified` → verified;
`expired` → expired; `unregistered`, `invalid`, `unknown`, and no
attestation found → unverified. For a `discord_application` subject,
even a `verified` core result renders neutral `Claim unconfirmed`
art, because the signature and AgentBook check do not prove control
of the named application. The JSON route preserves the core status
and evidence; readers must not treat it as an app-control or
guild-role decision. A check that did not complete
never renders verified and never renders the verified design's
colours. Failure is grey.

The pill carries the visible check time (`checked 14:03 UTC`, plus
the date when it is not today) in the muted style of its state,
the full `checkedAt` in the SVG `<title>` and `data-checked-at`
attribute, and `X-Checked-At` on the response: an image host that
strips metadata cannot make the badge look fresher than the
visible time. The check time is the time of the check that
produced the image; a cache hit does not refresh it.

The badge image carries no human identifier in any form: no raw
identifier, no hash, no wallet address, and the failure reason
never appears on the image. Detail lives on the JSON route, where
a person or machine chose to look, in the public shape only.

## JSON status

`GET /v1/status/...` returns the core's public projection
(`toPublicVerifyResult`) — status, truncated address, the
canonical human hash when verified, failure codes, evidence —
plus `subject`, `checkedAt`, and, for application subjects, the badge
URL block `badge: { svg: { auto, dark, light }, png: { auto, dark,
light } }`. Address subjects return `badge: null`; a working
address badge URL would have to include the full address and expose
it to logs and browser history. The
internal verify result is never serialised on any route. A subject
with no attestation returns status `unknown` with failure
`attestation_not_found` (never `unregistered`: nothing was checked
on-chain for the subject itself). A dead RPC likewise returns 200
with status `unknown`: the subject's status is the content, the
transport worked. Only malformed requests 400 (a malformed address
on the JSON route; on the badge routes it renders the unverified
badge with `Cache-Control: no-store`, because an `<img>` cannot
usefully show a 400), and only an internal rendering fault 500s.

For an `address` subject, the disclosure rule is exact: the
queried address appears **once** in the body, as the explicit
`subject` echo. The response omits address badge URLs rather than
publishing dead links made from a truncated address (spec 4.9).
For every other subject type the body contains no
wallet address at all unless it is the subject itself. This
address response differs from MCP `badge_status`, which currently
returns a badge URL matrix. Address and registry parity across the
two surfaces is a later SPEC sections 4.2 and 11 release gate.

Responses that report no check — rate-limited (429) and
malformed-subject (400, and the grey badge on image routes) —
carry **no check time**: no `X-Checked-At` header, no visible
check label, no `data-checked-at`. A check time is evidence from
the core (spec 4.4); the service never fabricates one. `HEAD` is
answered per route with the GET headers and no body; other
non-GET methods are 405. Invalid `theme`/`variant` values are
400, never silently coerced, and route near-misses on the badge
routes (empty ID, uppercase extension, trailing slash) serve the
grey no-store badge rather than the real one. Subject type and ID
are capped at the core's limits (64 / 256 chars).

## Configuration

Environment only; values are never committed. The core RPC names
mirror the verify MCP package's. Registry inputs are configured
separately for this service, as described below.

Numeric configuration is strict (the M16 standard): an explicitly
set zero, negative, or non-integer value for any numeric variable
is a startup error naming the variable — never a silent
disablement and never a silent default. Startup failures print
one sanitised line (variable + problem class, no file content, no
stack) and exit non-zero. Registry numeric settings are validated
even when no registry is configured.

| Variable | Meaning |
|---|---|
| `PORT` / `BADGE_PORT` | listen port (default 8788) |
| `BADGE_HOST` | bind address (default `127.0.0.1`, loopback) |
| `VERIFY_RPC_URL` (`WORLDCHAIN_RPC_URL`) | World Chain RPC endpoint |
| `VERIFY_CONTRACT_ADDRESS` (`AGENTBOOK_CONTRACT`) | AgentBook contract override |
| `VERIFY_TIMEOUT_MS` | core per-lookup deadline (default 5000) |
| `VERIFY_REGISTRY_FILE` (`REGISTRY_FILE`) | registry file, see below |
| `VERIFY_REGISTRY_URL` (`REGISTRY_URL`) | HTTPS registry URL; use instead of a file |
| `REGISTRY_REFRESH_MS` | registry reload interval (default 300000, spec 4.6) |
| `REGISTRY_MAX_BYTES` | registry file size bound at load (default 1048576) |
| `BADGE_PUBLIC_BASE_URL` | HTTP(S) base for badge URLs in JSON; credentials, query, and fragment are rejected; request headers are never used (default: path-relative URLs) |
| `RATE_LIMIT_TRUSTED_PROXIES` | comma-separated exact proxy IPs allowed to supply the rightmost `X-Forwarded-For` client address (default: none) |
| `CACHE_TTL_VERIFIED_MS`, `CACHE_TTL_NEGATIVE_MS`, `STALE_ON_ERROR_MS` | cache overrides |
| `CACHE_MAX_ENTRIES` | result-cache LRU bound (default 1000) |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` | rate limit overrides |
| `MAX_CONCURRENT_LOOKUPS`, `LOOKUP_QUEUE_MAX`, `LOOKUP_DEADLINE_MS` | outbound lookup concurrency, queue bound, and per-lookup deadline |
| `BADGE_REQUEST_TIMEOUT_MS` | whole source and core request deadline, capped at 5000 ms |

The bind is **loopback by default**: this service is
unauthenticated by design, so a wildcard bind is an exposure
decision, not a default. Setting `BADGE_HOST` to a non-loopback
address starts the service with a loud stderr warning saying so.

No secret is required to run this service at all. It holds no
signing keys and can never create one: it verifies signatures, it
never creates them. Its only durable-adjacent state is the
in-memory cache; a restart costs one re-check per subject.

## Registry shape

The public `registry.json` uses `version: 1` and `entries[]`.
Each active entry names a Discord application ID and an HTTPS
attestation URL. The service can read this file locally or fetch
the registry from an HTTPS URL. It fetches the selected attestation
through a guarded HTTPS client with destination and response bounds.
Registry and attestation data refresh after 300 seconds. A removed
or revoked entry then stops verifying. A failed source request
produces an uncached unknown result; it does not claim that
AgentBook is unavailable.

```json
{
  "version": 1,
  "entries": [
    {
      "discord_application_id": "123456789012345678",
      "attestation_url": "https://example.com/attestations/example.json"
    }
  ]
}
```

For self-hosted installations, the original nested map of subject
type → subject ID → signed attestation remains supported as a local
file. It is size-bounded and validated at startup, then refreshed
on the configured interval. Internal subject keys use the JSON
encoding of `[type, id]`, avoiding collisions between pairs that
contain punctuation. The canonical `entries[]` file and remote URL
use the guarded resolver; malformed or unavailable sources fail
closed. There is no request-selected `?url=` fetch route.

The verify MCP server uses a flat inline registry keyed by
`type:id`; it does not consume this service's `entries[]` or nested
file as interchangeable configuration. The two services need their
own registry settings. Aligning their registry and address badge
contracts remains a SPEC sections 4.2 and 11 release gate.

## Cache policy (spec 4.6, proposals implemented as configuration)

The spec's cache numbers are proposals; they are implemented here
as configuration defaults, labelled as proposals, not constants:

| Observed state | `Cache-Control` |
|---|---|
| `verified` | `public, max-age=300, s-maxage=300` for address checks at first check, reduced on server cache hits |
| `expired` | `public, max-age=300, s-maxage=300` |
| `unregistered` / `invalid` | `public, max-age=60, s-maxage=60` |
| `unknown` / any failure | `no-store` |

Discord application claims are always `no-store`. Even when the
wallet check passes, their image stays neutral and says
`Claim unconfirmed` until a separate application-control gate exists.

Server-side, verification results cache under the same TTLs
(theme-independent; one entry serves every theme) in a **bounded
LRU** (`CACHE_MAX_ENTRIES`, default 1000, negatives included — an
attacker enumerating subjects cannot grow it without limit).
Concurrent requests for one subject share a single in-flight
lookup, and a failed refresh may serve a cached `verified`
result younger than 900s with its original check time (the JSON
route then marks `evidence.source: 'cache'` and the response is
`no-store`, so the stale serve cannot be re-cached downstream).
Older than 900s, or no cache: unverified with status `unknown`.
Serving a quietly-fresh-looking stale verified badge is the one
failure this service must never have.
When a local registry refreshes, new requests stop joining old
source and core work; an old result cannot repopulate the cache
after the registry version changes.

Rendered badges are cached by the same identity as their `ETag`
(subject, status, check time, variant, format, theme, configured
base), and `If-None-Match` is honoured with a 304 **before** any
rendering happens: a repeated or conditional request never pays
rasterisation twice for the same badge state. ETags are computed
from the configured base only, so they are stable — and safe to
store in shared caches — no matter what `Host` a request carried.

Abuse posture: per-key rate limit (default 120 req/min) on the
badge and status routes, keyed on the socket address (or on
`X-Forwarded-For` only from an IP in `RATE_LIMIT_TRUSTED_PROXIES`).
Over-limit returns 429 on the JSON route; on badge
routes it serves the subject's last render when one exists, else
a reusable unchecked badge — in both cases `no-store`. A global
concurrency cap plus a bounded queue with a
per-lookup deadline bounds outbound core lookups (the core
receives the deadline's `AbortSignal`, and the service enforces
the deadline even if the core ignores it). Saturation or an elapsed
lookup deadline returns 503 on the JSON route and an unchecked
badge on image routes; a thrown core check also yields an unchecked
badge. HTTP
server timeouts are set explicitly. The whole source and core
response has a five-second deadline.

An over-limit request reuses the last observed badge only until
that check's original cache deadline. Afterward it gets unchecked
art with no check time, so a verified image cannot remain visible
indefinitely because the rate limiter prevents rechecking. PNG
fallbacks are cached separately by theme and variant, for both
SVG and PNG.

## Tests

`npm test` runs the route-level suite against a fake verifier and
a fake resolver, booting the real server on an ephemeral port:
every core status × theme × format combination's rendering,
headers, and cache control; the auto-PNG hint/fallback/header
behaviour; golden-palette assertions against the canonical
tables; PNG pixel parity (dimensions, background and dot pixels)
against the SVG palette; resolver-null → `unknown` +
`attestation_not_found`; cache TTL, timestamp stability, and
stale-on-error behaviour with an injected clock; rate limiting;
`/health` flipping on lookup failure; and a deep scan of every
response body (headers included) the service can emit for the
fixture raw human identifier, a `humanId` key, and the full wallet
address. The review fix pass added: the composite-key conflation
pair returning independent results and badges; host-poisoning
(URL/ETag invariant under a spoofed `Host`); render-count tests
proving repeated, conditional, and rate-limited requests render
at most once per badge state; the cache bound at 5000 subjects;
registry refresh/removal, reload-failure, and startup-validation
tests through the production `depsFromEnv` wiring; numeric-config
strictness; queue saturation (503 + the core's `AbortSignal`);
malformed percent-encoding; HEAD/405 semantics; near-miss routes;
length caps; the address-echo-exactly-once rule; an induced-500
scan; and accessible-name/layout regressions. Fixtures are
synthetic and invented, never recorded.
