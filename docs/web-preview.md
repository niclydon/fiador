# Fiador web preview

The repository root is the Vercel project root. The project uses the **Other**
framework preset and Node 24. `npm run build:web` bundles the browser verifier
and copies the approved static files to ignored `public/`. It publishes `/`,
`/verify/`, `/registry.json`, and `/attestations/nova.json` from the same build.
The public registry is copied from the canonical `registry/registry.json`, not
from the page's older local mirror. Two `vercel.json` rewrites send `/v/:id`
and `/v/:id/card.svg` to the root `api/preview.ts` function, which calls the
existing framework-free link-preview handler. The public registry and
attestation routes allow cross-origin browser reads; all other static assets
stay same-origin. The preview function has a 20 second maximum to let the
handler return its bounded 15 second **Could not check** state.

The function reads the bundled canonical registry. This makes the protected
preview self-contained and ensures it uses the same registry bytes as
`/registry.json`. A registry change needs a new deployment. On a preview,
Vercel's deployment URL is used for card and click-through links so a browser
stays on that preview. In production the base URL defaults to
`https://fiador.org`. The preview function requires Vercel's `VERCEL_URL`
system variable and fails if it is absent. Preview cards are staging evidence,
not canonical Fiador links to publish.

## Local verification

From the repository root:

```sh
npm ci
npm run build:web
npm run typecheck
npm test
```

`npm test` includes route, static-output, browser redirect, crawler-page, and
SVG card checks. These use a local fixture and synthetic network responses;
they do not establish deployed behavior or live chain reads.

## Protected preview deployment

After exact-head review, run these commands from the repository root while
signed into the Vercel scope that owns the existing `fiador` project:

```sh
npx --yes vercel@latest link --yes --project fiador
fiador_preview_url="$(npx --yes vercel@latest deploy --yes)"
```

Confirm that `vercel link` selected the existing project before deploying.
`vercel deploy` without `--prod` creates a preview and does not assign the
production domain. Keep Vercel Deployment Protection enabled for the preview.
Use the captured preview URL for smoke checks. The synthetic `aaaaaaaaaa`
route below exercises the dynamic wiring without publishing a real claim:

```sh
npx --yes vercel@latest curl / --deployment "$fiador_preview_url"
npx --yes vercel@latest curl /verify/ --deployment "$fiador_preview_url"
npx --yes vercel@latest curl /registry.json --deployment "$fiador_preview_url"
npx --yes vercel@latest curl /attestations/nova.json --deployment "$fiador_preview_url"
npx --yes vercel@latest curl /v/aaaaaaaaaa --deployment "$fiador_preview_url"
npx --yes vercel@latest curl /v/aaaaaaaaaa/card.svg --deployment "$fiador_preview_url"
```

Inspect the `/v/` route both with a browser and a crawler user agent. The
browser should reach `/verify/` on the same preview; the crawler should get
Open Graph metadata and an SVG card. A live result can still be **Could not
check** if the canonical attestation host or World Chain RPC is unavailable.
Treat that as a failed live proof, not a deployment success.

Before public `/v/` links or domain promotion, verify browser CORS and RPC
behavior, the signed attestation at its canonical URL, a real chain check,
and the application's control evidence. The claim remains **Claim
unconfirmed** until that independent control proof exists. Some link-preview
clients do not render SVG `og:image`; raster PNG generation and a real
Discord unfurl test are separate open gates. No production deployment is part
of this preview run.
