// The crawler-facing page (DESIGN §6.4): Open Graph meta plus a small
// human-readable body carrying the same verdict. The meta description
// ships the snapshot caveat, not just this design doc: a preview is a
// crawl-time snapshot, platform caches may never refresh it, and the
// verification is the live click-through check on the canonical domain.

import { DESCRIPTOR, STATE_WORD, escapeXml } from './card.js';
import type { CardState } from './card.js';

export const SNAPSHOT_CAVEAT =
  'This preview is a snapshot from crawl time, not the proof: platform ' +
  'preview caches mean a later expiry or revocation may not refresh a ' +
  'preview already posted, and a lookalike domain can imitate a card. ' +
  'The verification is the click-through check on fiador.org, run live ' +
  'at open time.';

export interface OgPageOptions {
  state: CardState;
  applicationName: string;
  verdict: string;
  checkedAt: string;
  /** Canonical https://fiador.org/v/<short-id> */
  canonicalUrl: string;
  /** The og:image target (the card route). */
  cardUrl: string;
  /** Where a human click-through lands (the verify page). */
  verifyUrl: string;
}

export function renderOgPage(opts: OgPageOptions): string {
  const title = `Fiador — ${opts.applicationName} — ${STATE_WORD[opts.state]}`;
  const description = `${opts.verdict} ${SNAPSHOT_CAVEAT}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${escapeXml(title)}</title>
<meta name="description" content="${escapeXml(description)}"/>
<meta property="og:type" content="website"/>
<meta property="og:site_name" content="Fiador"/>
<meta property="og:title" content="${escapeXml(title)}"/>
<meta property="og:description" content="${escapeXml(description)}"/>
<meta property="og:url" content="${escapeXml(opts.canonicalUrl)}"/>
<meta property="og:image" content="${escapeXml(opts.cardUrl)}"/>
<meta property="og:image:type" content="image/svg+xml"/>
<meta property="og:image:width" content="1200"/>
<meta property="og:image:height" content="630"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${escapeXml(title)}"/>
<meta name="twitter:description" content="${escapeXml(description)}"/>
<meta name="twitter:image" content="${escapeXml(opts.cardUrl)}"/>
</head>
<body>
<main>
<p>${escapeXml(DESCRIPTOR)}</p>
<h1>${escapeXml(STATE_WORD[opts.state])}</h1>
<p>${escapeXml(opts.applicationName)}</p>
<p>${escapeXml(opts.verdict)}</p>
<p>Checked ${escapeXml(opts.checkedAt)} (crawl time). ${escapeXml(SNAPSHOT_CAVEAT)}</p>
<p><a href="${escapeXml(opts.verifyUrl)}">Verify this attestation live on fiador.org</a></p>
</main>
</body>
</html>`;
}
