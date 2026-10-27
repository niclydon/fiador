# Fiador badge service

The dynamic badge service from the W0 verify core spec (section 4):
a stateless HTTP service whose only job is to resolve a subject,
run `@fiador/verify` at request time, and render the project's
badge for the observed state. A static badge is a claim anyone can
copy; a served badge names its subject in its URL and always
reports that subject's real, freshly checked status.

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
npm start            # listens on PORT (default 8788)
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
from them). The core's status maps as: `verified` → verified;
`expired` → expired; `unregistered`, `invalid`, `unknown`, and no
attestation found → unverified. A check that did not complete
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
plus `subject`, `checkedAt`, and the badge URL block
`badge: { svg: { auto, dark, light }, png: { auto, dark, light } }`,
the same shape the verify MCP's `badge_status` tool returns. The
internal verify result is never serialised on any route. A subject
with no attestation returns status `unknown` with failure
`attestation_not_found` (never `unregistered`: nothing was checked
on-chain for the subject itself). A dead RPC likewise returns 200
with status `unknown`: the subject's status is the content, the
transport worked. Only malformed requests 400 (a malformed address
on the JSON route; on the badge routes it renders the unverified
badge with `Cache-Control: no-store`, because an `<img>` cannot
usefully show a 400), and only an internal rendering fault 500s.

## Configuration

Environment only; values are never committed. Names mirror the
verify MCP package's, with the spec section 4.8 spellings accepted
as fallbacks.

| Variable | Meaning |
|---|---|
| `PORT` / `BADGE_PORT` | listen port (default 8788) |
| `VERIFY_RPC_URL` (`WORLDCHAIN_RPC_URL`) | World Chain RPC endpoint |
| `VERIFY_CONTRACT_ADDRESS` (`AGENTBOOK_CONTRACT`) | AgentBook contract override |
| `VERIFY_TIMEOUT_MS` | per-lookup deadline (default 5000) |
| `VERIFY_REGISTRY_FILE` (`REGISTRY_FILE`) | registry file, see below |
| `BADGE_PUBLIC_BASE_URL` | base for badge URLs in JSON (default: derived from the request) |
| `CACHE_TTL_VERIFIED_MS`, `CACHE_TTL_NEGATIVE_MS`, `STALE_ON_ERROR_MS` | cache overrides |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` | rate limit overrides |

No secret is required to run this service at all. It holds no
signing keys and can never create one: it verifies signatures, it
never creates them. Its only durable-adjacent state is the
in-memory cache; a restart costs one re-check per subject.

## Registry shape

The attestation source is a local JSON file mapping
`"subjectType:subjectId"` to a signed attestation object — the
same shape the verify MCP configures — loaded at startup (restart
to reload):

```json
{
  "discord_application:123456789012345678": {
    "payload": { "...": "the attestation payload" },
    "signature": "0x...",
    "signatureType": "eip191"
  }
}
```

One deliberate divergence from the spec text, flagged in the PR:
spec 4.2 describes the v1 registry as the W1 `registry.json` shape
(subject → attestation URL) with an optional fetch fallback under
4.7's SSRF guard set. This build follows the tasking and the MCP
package's shipped shape instead: attestations arrive as data in
the deployment's own file, and the service fetches nothing, ever.
There is no `?url=` route and no fetch helper; a caller gains no
SSRF primitive from this service. Supporting the URL registry
shape later is an additive change behind the same resolver
interface, with 4.7's guards implemented in full at that point.

## Cache policy (spec 4.6, proposals implemented as configuration)

The spec's cache numbers are proposals; they are implemented here
as configuration defaults, labelled as proposals, not constants:

| Observed state | `Cache-Control` |
|---|---|
| `verified` | `public, max-age=300, s-maxage=300, stale-while-revalidate=60` |
| `expired` | `public, max-age=300, s-maxage=300` |
| `unregistered` / `invalid` | `public, max-age=60, s-maxage=60` |
| `unknown` / any failure | `no-store` |

Server-side, verification results cache under the same TTLs
(theme-independent; one entry serves every theme), concurrent
requests for one subject share a single in-flight lookup, and a
failed refresh may serve a cached `verified` result younger than
900s with its original check time (the JSON route then marks
`evidence.source: 'cache'` and the response is `no-store`, so the
stale serve cannot be re-cached downstream). Older than 900s, or
no cache: unverified with status `unknown`. Serving a
quietly-fresh-looking stale verified badge is the one failure
this service must never have.

Abuse posture: per-IP rate limit (default 120 req/min) on the
badge and status routes; over-limit returns 429 on the JSON route
and the unverified badge with `no-store` on badge routes, so an
embed never breaks a page layout because of limiting. A global
concurrency cap bounds outbound core lookups.

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
address. Fixtures are synthetic and invented, never recorded.
