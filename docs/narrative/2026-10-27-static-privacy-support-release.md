# 2026-10-27 — static privacy and support release

This branch starts at the verified deployed site commit `4f366af`.
It adds two public information pages while preserving the
existing founding attestation and registry byte for byte. The
Fiador Slack app remains an owner-only trial: private backend health
checks have run in closed mode, but owner enrollment, Slack sign-in,
and a World ID check have not run live as of this record. General
enrollment remains closed. At preparation, this was a local
candidate. It was later staged in draft PR #26 and a protected preview;
the operator then approved its separate production publication.

## Published file boundary

The fixed static build copies only these eight files to `public/`:

1. `index.html`
2. `privacy/index.html`
3. `support/index.html`
4. `style.css`
5. `theme.js`
6. `assets/fiador-banner.webp`
7. `registry.json`
8. `attestations/nova.json`

Vercel is configured to serve this directory without a function or
rewrite. Neither the prepared browser checker nor the link preview
is copied. The home page change is limited to links to the two new
pages; the signed attestation and canonical registry are unchanged.
The new pages explain what is public now, label the browser checker
as not yet public, and describe the separate Slack trial without
claiming a completed owner check.

## Pre-publication evidence

`node scripts/build-pages-static.mjs` followed by
`node --test scripts/static-web.test.mjs` passed three checks:
exact output allowlist and source bytes, pinned registry and
attestation digests, and a function-free Vercel configuration.
Local HTTP checks returned 200 for the five intended routes and
404 for `/verify/`, `/v/example`, and `/api/preview`. Playwright
CLI 1.64.1 with Chromium covered both new pages on a 1280 × 800
light desktop and a 390 × 844 dark mobile viewport. The copy,
banner, cards, and footer links rendered without clipping.

Gitleaks 8.30.1 scanned the full working tree and all git refs
after the candidate was committed. The tree yielded five known
synthetic test-fixture findings under `link-preview/test/`,
`tools/signer/test/`, and `verifier-bot/tests/`: three
`discord-client-id` examples and two `generic-api-key` examples.
The all-refs history yielded fifteen findings in the same fixture
classes, including repeated findings across commits. No changed
path was flagged. This disposition applies to those test literals,
not to any operational credential. A private identifier scan found
no full identifier or 12-character wallet/hash fragment in the
changed lines. The pre-existing public attestation remains
byte-identical.

At this checkpoint, live `https://fiador.org/privacy/` and
`https://fiador.org/support/` both returned 404; the three
unshipped routes also returned 404. Live `/registry.json` and
`/attestations/nova.json` returned 200 and were byte-identical
to the static build. Their SHA-256 digests are recorded in
`docs/verification.md`. A protected Vercel preview built from `54bb3cd`
reached READY. In that preview, `/privacy/` and `/support/` returned
200, while `/verify/`, `/v/example`, and `/api/preview` returned 404.
Its registry and attestation responses were byte-identical to the
existing production deployment, including the public CORS header.
An independent adversarial review found no blocking issue. These
checks preceded the production decision.

## Production publication

After operator approval, Vercel production deployment
`dpl_2ZYomdjYFfzdYsMw82SqsPof56sk` reached READY from branch commit
`9b5bc30781333376f8bea1459f03d5069e201858`. Both `fiador.org`
and `www.fiador.org` are attached. This branch deployment did not
merge draft PR #26 into `main`; that PR remains open for review.

Live checks returned 200 for `/`, `/privacy/`, `/support/`,
`/registry.json`, and `/attestations/nova.json`. The registry and
attestation responses were byte-identical to the branch's public
files and retained `Access-Control-Allow-Origin: *`. `/verify/`,
`/v/example`, and `/api/preview` returned 404. The production home
page did not include the injected feedback marker seen in the
protected preview. The result is a static information release; it
does not establish live Slack sign-in, a completed World ID check,
or bot control.
