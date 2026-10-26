// The /v/ link-preview handler (DESIGN §6.4). Framework-free
// Request -> Response, so it sits behind the thinnest platform adapter
// (see api/) and nothing else in here knows what hosts it.
//
// Behaviour summary:
// - Crawlers get the OG page (meta + the dynamic card as og:image);
//   browsers get a 302 to the verify page, prefilled when an
//   attestation is known. Same verdict, two readers — never cloaking,
//   because both renderings come from the one crawl-time check below.
// - Verification runs at crawl time through the verify core, and only
//   the public projection (toPublicVerifyResult) is rendered from.
// - Fail-closed: an unknown id is a neutral "attestation not found"
//   card with full meta (never a bare 404), and any lookup failure is
//   an explicit "could not check" card served no-store — never a
//   verified-looking card, never cached into looking settled.

import { toPublicVerifyResult } from '@fiador/verify';
import type { FailureCode, PublicVerifyResult } from '@fiador/verify';
import type { LinkPreviewDeps } from './deps.js';
import { normalizeBaseUrl } from './deps.js';
import { normalizeEntries } from './registry.js';
import type { RegistryEntry } from './registry.js';
import { applicationNameFor, resolveShortId } from './resolve.js';
import type { Resolution } from './resolve.js';
import { DEFAULT_VERDICT, renderCard } from './card.js';
import type { CardState } from './card.js';
import { renderOgPage } from './page.js';

const CRAWLER_TOKENS = [
  'discordbot',
  'twitterbot',
  'slackbot',
  'slack-imgproxy',
  'facebookexternalhit',
  'facebookcatalog',
  'whatsapp',
  'telegrambot',
  'linkedinbot',
  'pinterest',
  'redditbot',
  'skypeuripreview',
  'googlebot',
  'bingbot',
  'embedly',
  'bot',
  'crawler',
  'spider',
  'preview',
];

export function isCrawlerUserAgent(userAgent: string | null): boolean {
  if (!userAgent) return false;
  const lower = userAgent.toLowerCase();
  return CRAWLER_TOKENS.some((token) => lower.includes(token));
}

interface Route {
  id: string;
  card: boolean;
}

function parseRoute(pathname: string): Route | null {
  const segments = pathname.split('/').filter((s) => s.length > 0);
  if (segments.length < 2 || segments[0] !== 'v') return null;
  let id = segments[1];
  let card = false;
  if (segments.length === 3) {
    if (segments[2] === 'card' || segments[2] === 'card.svg') card = true;
    else return null;
  } else if (segments.length !== 2) {
    return null;
  }
  if (id.endsWith('.svg')) {
    card = true;
    id = id.slice(0, -'.svg'.length);
  }
  if (id.length === 0) return null;
  return { id: id.toLowerCase(), card };
}

const CACHE_STATE = 'public, max-age=300, s-maxage=300';
const CACHE_NOT_FOUND = 'public, max-age=60, s-maxage=60';
const CACHE_FAILURE = 'no-store';

function svgResponse(svg: string, cacheControl: string): Response {
  return new Response(svg, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': cacheControl,
    },
  });
}

interface PageContext {
  state: CardState;
  applicationName: string;
  verdict: string;
  checkedAt: string;
  cardUrl: string;
  verifyUrl: string;
  /** Only ever set from the attestation payload itself (opt-in, §3.1.1). */
  operatorName?: string;
}

function pageResponse(
  ctx: PageContext,
  canonicalUrl: string,
  cacheControl: string,
): Response {
  const html = renderOgPage({
    state: ctx.state,
    applicationName: ctx.applicationName,
    verdict: ctx.verdict,
    checkedAt: ctx.checkedAt,
    canonicalUrl,
    cardUrl: ctx.cardUrl,
    verifyUrl: ctx.verifyUrl,
  });
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': cacheControl,
    },
  });
}

function invalidVerdict(failures: FailureCode[]): string {
  if (failures.includes('signature_mismatch')) {
    return 'Not verified: the attestation signature does not verify against its wallet.';
  }
  if (failures.includes('subject_mismatch') || failures.includes('wallet_mismatch')) {
    return 'Not verified: this attestation is bound to a different subject than the one it was presented for.';
  }
  if (failures.includes('malformed_attestation') || failures.includes('unsupported_version')) {
    return 'Not verified: this attestation is malformed.';
  }
  if (failures.includes('replay_detected')) {
    return 'Not verified: this attestation has already been presented (replay).';
  }
  return 'Not verified: this attestation failed verification.';
}

export async function handleRequest(
  req: Request,
  deps: LinkPreviewDeps,
): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('method not allowed', {
      status: 405,
      headers: { allow: 'GET, HEAD' },
    });
  }

  const url = new URL(req.url);
  const route = parseRoute(url.pathname);
  if (!route) {
    return new Response('not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const baseUrl = normalizeBaseUrl(deps.baseUrl);
  const canonicalUrl = `${baseUrl}/v/${route.id}`;
  const cardUrl = `${baseUrl}/v/${route.id}/card.svg`;
  const bareVerifyUrl = `${baseUrl}/verify/`;
  const isCrawler = isCrawlerUserAgent(req.headers.get('user-agent'));
  const nowIso = () => deps.now().toISOString();

  const failureCard = (): Response =>
    svgResponse(
      renderCard('could_not_check', {
        applicationName: 'Discord application',
        checkedAt: nowIso(),
      }),
      CACHE_FAILURE,
    );
  const failurePage = (): Response =>
    pageResponse(
      {
        state: 'could_not_check',
        applicationName: 'Discord application',
        verdict: DEFAULT_VERDICT.could_not_check,
        checkedAt: nowIso(),
        cardUrl,
        verifyUrl: bareVerifyUrl,
      },
      canonicalUrl,
      CACHE_FAILURE,
    );
  // For state-like responses: card route -> SVG, crawler -> OG page,
  // browser -> the verify page (prefilled when an attestation is known).
  const stateResponse = (
    ctx: PageContext,
    cacheControl: string,
    browserTarget: string,
  ): Response => {
    if (route.card) {
      return svgResponse(
        renderCard(ctx.state, {
          applicationName: ctx.applicationName,
          operatorDisplayName: ctx.operatorName,
          checkedAt: ctx.checkedAt,
          verdict: ctx.verdict,
        }),
        cacheControl,
      );
    }
    if (!isCrawler) {
      return new Response(null, {
        status: 302,
        headers: { location: browserTarget },
      });
    }
    return pageResponse(ctx, canonicalUrl, cacheControl);
  };

  let entries: RegistryEntry[];
  try {
    entries = normalizeEntries(await deps.registrySource());
  } catch {
    if (route.card) return failureCard();
    if (!isCrawler) {
      return new Response(null, { status: 302, headers: { location: bareVerifyUrl } });
    }
    return failurePage();
  }

  const resolution: Resolution = await resolveShortId(
    entries,
    route.id,
    deps.attestationFetcher,
  );

  switch (resolution.kind) {
    case 'lookup_failed': {
      if (route.card) return failureCard();
      if (!isCrawler) {
        return new Response(null, {
          status: 302,
          headers: { location: bareVerifyUrl },
        });
      }
      return failurePage();
    }
    case 'not_found': {
      const ctx: PageContext = {
        state: 'not_found',
        applicationName: 'Discord application',
        verdict: DEFAULT_VERDICT.not_found,
        checkedAt: nowIso(),
        cardUrl,
        verifyUrl: bareVerifyUrl,
      };
      return stateResponse(ctx, CACHE_NOT_FOUND, bareVerifyUrl);
    }
    case 'revoked': {
      const verifyUrl = `${bareVerifyUrl}?attestation=${encodeURIComponent(
        resolution.entry.attestation_url,
      )}`;
      const ctx: PageContext = {
        state: 'revoked',
        applicationName: applicationNameFor(resolution.entry),
        verdict: DEFAULT_VERDICT.revoked,
        checkedAt: nowIso(),
        cardUrl,
        verifyUrl,
      };
      return stateResponse(ctx, CACHE_STATE, verifyUrl);
    }
    case 'live': {
      const { entry, attestation } = resolution;
      const verifyUrl = `${bareVerifyUrl}?attestation=${encodeURIComponent(
        entry.attestation_url,
      )}`;
      // Browsers never wait on a check: the verify page re-runs it live.
      if (!route.card && !isCrawler) {
        return new Response(null, {
          status: 302,
          headers: { location: verifyUrl },
        });
      }
      let pub: PublicVerifyResult;
      try {
        const result = await deps.verifier.resolveStatus({
          kind: 'attestation',
          attestation,
        });
        pub = toPublicVerifyResult(result);
      } catch {
        return route.card ? failureCard() : failurePage();
      }
      if (pub.status === 'unknown') {
        return route.card ? failureCard() : failurePage();
      }
      let state: CardState;
      let verdict: string;
      switch (pub.status) {
        case 'verified':
          state = 'verified';
          verdict = DEFAULT_VERDICT.verified;
          break;
        case 'expired':
          state = 'expired';
          verdict = DEFAULT_VERDICT.expired;
          break;
        case 'unregistered':
          state = 'unverified';
          verdict =
            'Not verified: the wallet behind this attestation is not registered in AgentBook.';
          break;
        default:
          state = 'unverified';
          verdict = invalidVerdict(pub.failures);
          break;
      }
      const operator = attestation.payload.operatorDisplayName;
      const ctx: PageContext = {
        state,
        applicationName: applicationNameFor(entry, attestation),
        verdict,
        checkedAt: pub.evidence.checkedAt,
        cardUrl,
        verifyUrl,
        operatorName:
          typeof operator === 'string' && operator.length > 0
            ? operator
            : undefined,
      };
      return stateResponse(ctx, CACHE_STATE, verifyUrl);
    }
  }
}
