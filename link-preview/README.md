# @fiador/link-preview — the `/v/` surface

Fiador — human-backed attestation for Discord bots. This package is the
attestation link preview from DESIGN §6.4: the surface that makes a
bot's one short link speak for itself when it is pasted into Discord
(or any other Open Graph consumer).

A bot or operator posts the canonical URL:

```
https://fiador.org/v/<short-id>
```

The short-id is content-derived: the first 10 characters (minimum; it
extends on collision) of the base32 encoding of SHA-256 over the
attestation's canonical signing bytes. Any change to the payload
changes the id, so a link names one exact attestation, not a slot
whose contents can be swapped. Resolution needs no accounts and no
database: the handler matches the id against the published registry
(§3.4), fetching live entries with at most four requests in flight
and computing each id,
with tombstones (entries marked `"status": "revoked"`) matched from
their recorded payload hash so old links render an honest revoked
card without depending on dead hosting.

## Behaviour

- **Crawlers** (Discordbot, Twitterbot, Slackbot, facebookexternalhit,
  and a documented heuristic list in `src/handler.ts`) get an OG page:
  meta plus a dynamically rendered 1200×630 card as `og:image`. The
  handler runs `verifyAttestation` with the registry application as
  the expected subject, then checks the signed Discord profile:
  hash-only disclosure, an allowlist of Discord-specific signed fields,
  the required lowercase human hash (against the live core result for
  current attestations), the signed URL against the fetched URL, and
  a valid bot user ID. Expired claims receive the same profile-shape
  checks before an **Expired** card appears. An optional independent Discord lookup
  can reject a reported bot user ID mismatch. Core results cross to
  this surface only through `toPublicVerifyResult`.
- **Application control remains unproven.** Neither a signed claim
  naming a public Discord application nor a registry entry proves
  that the wallet holder controls that application. Even a matching
  Discord-reported bot user ID does not establish that relationship.
  Until a trusted control assertion exists, a core-valid and
  profile-valid claim renders a neutral **Claim unconfirmed** card,
  never the gold **Verified** treatment.
- **Browsers** get a 302 to the verify page with the attestation
  prefilled (`{baseUrl}/verify/?attestation=<url>`). The full page is
  pending; it must re-run all checks at open time before these links
  form a complete verification flow.
- **The card** is one designed SVG artifact in the Nova Glass language
  (badge states and colours matching §6.2): state artwork and word,
  the application name (signed into the attestation, else the
  registry's recorded name, else the truncated application id — never
  invented), the operator display name **only** when the attestation
  itself carries it (the §3.1.1 opt-in), the descriptor line, the
  verdict in words, and the crawl timestamp.
- **Honesty, shipped in the copy**: the OG card is a snapshot from
  crawl time, not the proof. Platform preview caches mean a later
  expiry or revocation may never refresh a preview already posted,
  and a lookalike domain can imitate a card pixel for pixel. The
  current verification requires a live click-through check on the
  canonical domain. The caveat travels in the meta description,
  not only in the design doc.
- **Failure states, fail-closed**: an unknown id renders a neutral
  "attestation not found" card with full OG meta at HTTP 200 — never
  a bare 404 with no meta. Any lookup failure at crawl time (registry,
  attestation host, or the check itself returning `unknown`) renders
  an explicit "could not check" card in the unverified visual family,
  served `Cache-Control: no-store` — never a verified-looking card,
  and never cached into looking settled. If a live registry entry
  cannot be fetched during resolution, the answer is "could not
  check", not "not found": the requested id might be that entry.
  A signed Discord profile mismatch renders **Not verified** with
  the reason in words. A failed independent Discord lookup renders
  **Could not check** with `no-store`.

## Shape

- `src/handler.ts` — the whole surface as one framework-free
  `handleRequest(req, deps): Promise<Response>`.
- `src/deps.ts` — the injected boundary: registry source, guarded
  attestation fetcher, the verify core, canonical base URL, clock.
- `src/resolve.ts` — short-id resolution and name selection.
- `src/card.ts` / `src/page.ts` — the SVG card and the OG page.
- `api/v/[id].ts`, `api/v/[id]/card.ts` — the thin Vercel adapters.

## Hosting posture (§6.4, standing constraints)

V1 hosting is Vercel, right-sized for a small Discord demonstration.
(1) **Portability**: this package depends only on the verify core and
the published registry; the adapters under `api/` are the only
platform coupling, so a move to Cloudflare (Workers/Pages) — the
natural scale home, where the program's domains and DNS already live —
is a relocation, not a rewrite. (2) **Cost watch**: on-chain reads are
free, but serving pages and previews is not free at scale, and funding
public verification traffic out of pocket indefinitely is not a
standing commitment; if usage grows past hobby scale the traffic/cost
picture returns as a decision item with numbers rather than being
absorbed silently.

## Stub boundaries / deploy-time TODOs

- **og:image is SVG.** Some platforms ignore SVG Open Graph images.
  A rasterisation adapter (e.g. resvg) that renders the same card to
  PNG at the edge is a deploy-time TODO; the card renderer is pure
  string generation precisely so that adapter has one input to wrap.
- **Default deps use the live core.** `createDefaultDeps()` loads the
  published `/registry.json`, uses `createVerifier()` with its live
  AgentBook reader, and guards attestation URLs with HTTPS-only fetch,
  public-address DNS validation and connect-time pinning, no redirects,
  a 5 s timeout, and a 64 KiB body cap (§5.4). `FIADOR_REGISTRY_URL`,
  `FIADOR_RPC_URL`, and `FIADOR_BASE_URL` can override the defaults.
  The registry fetch also refuses redirects and is bounded to 5 s and
  64 KiB. The complete preview request has a 15 s budget, including
  registry resolution, the core verifier, and an optional Discord bot-ID
  lookup. A successful match cancels other active guarded fetches;
  a timed-out request returns a no-store "could not check" response.
  A signature RPC already started by the core may continue afterward:
  the core's ERC-1271 read has no abort channel. Registry, DNS,
  attestation host, and RPC failures render the same failure state. The default
  wiring has no independent Discord bot-ID lookup or trusted
  application-control assertion. Those require Discord integration
  before a public claim can be called verified.
- **Click-through destination is pending.** The static
  `verify-page/` hosting root serves the founding attestation and
  registry; it does not yet contain the full interactive `/verify/`
  page that a browser redirect requires. Do not publish `/v/` links
  as a finished verification flow until that page is built and tested.
- **Canonical domain only.** The surface ships only on fiador.org;
  a preview card served from anywhere else is not this surface
  (DESIGN §6.4). DNS/hosting for the domain follow the deploy
  decision; nothing here publishes a `/v/` link before that.
- **Resolution scans the registry per request.** Deliberately simple
  for v1 scale; the derived payload-hash index (§3.4) is the seam
  where caching lands if traffic ever justifies it — see the cost
  watch above.

## Tests

```
npm test        # vitest fakes plus an ephemeral local HTTPS socket; no external network or chain
npm run typecheck
```

The socket test generates a disposable self-signed certificate with
OpenSSL. Fixtures use synthetic identifiers only, and the suite deep-scans
response bodies to prove neither the fixture full humanId (which
exists only inside the internal verify result) nor the full wallet
address ever reaches this surface's output.
