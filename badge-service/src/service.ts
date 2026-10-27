// The badge service (W0 SPEC section 4): a stateless, keyless HTTP
// shell over @fiador/verify. Plain Node HTTP, deliberately: the
// routes and headers are the spec, the framework is a build choice
// (4 preamble), and a read-only service that holds no keys should
// carry the smallest dependency surface that serves it.
//
// The service consumes the core ONLY through its public exports
// entry point (the one-way dependency rule, SPEC 1.1): it calls
// createVerifier-produced methods and toPublicVerifyResult, and it
// renders from the returned status only. It never sets
// includeRawHumanId, and the internal VerifyResult is never
// serialised on any route: every wire body crosses the projection.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  toPublicVerifyResult,
  type SignedAttestation,
  type VerificationStatus,
  type VerifyResult,
  type Verifier,
} from '@fiador/verify';
import { explainerHtml } from './explainer.js';
import { stateForStatus, type BadgeVariant, type ThemeName } from './palettes.js';
import { renderBadgePng, renderBadgeSvg, type ThemeSelection } from './render.js';

export interface BadgeServiceDeps {
  verifier: Verifier;
  /** Subject -> attestation resolver (registry-backed in deployed
   * configuration; see config.ts). Absent, every attested subject
   * resolves as not found. */
  resolveAttestation?: (subject: { type: string; id: string }) => Promise<SignedAttestation | null>;
  /** Absolute base for badge URLs in the JSON route. Absent, the
   * base is derived from the request (Host / X-Forwarded-Proto). */
  publicBaseUrl?: string;
  now?: () => Date;
  /** SPEC 4.6 proposals, as configuration (not code constants). */
  cacheTtlVerifiedMs?: number; // verified + expired, default 300_000
  cacheTtlNegativeMs?: number; // unregistered + invalid, default 60_000
  staleOnErrorMs?: number; // stale verified ceiling, default 900_000
  rateLimitMax?: number; // per IP per window, default 120
  rateLimitWindowMs?: number; // default 60_000
  maxConcurrentLookups?: number; // outbound core-call cap, default 10
}

interface CacheEntry {
  result: VerifyResult;
  storedAtMs: number;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function badgeUrls(base: string, subjectType: string, subjectId: string) {
  const path = `${base.replace(/\/$/, '')}/badge/${encodeURIComponent(subjectType)}/${encodeURIComponent(subjectId)}`;
  const byTheme = (ext: string) => ({
    auto: `${path}.${ext}?theme=auto`,
    dark: `${path}.${ext}?theme=dark`,
    light: `${path}.${ext}?theme=light`,
  });
  return { svg: byTheme('svg'), png: byTheme('png') };
}

/** SPEC 4.6 HTTP cache table, keyed by observed status. */
export function cacheControlFor(status: VerificationStatus): string {
  switch (status) {
    case 'verified':
      return 'public, max-age=300, s-maxage=300, stale-while-revalidate=60';
    case 'expired':
      return 'public, max-age=300, s-maxage=300';
    case 'unregistered':
    case 'invalid':
      return 'public, max-age=60, s-maxage=60';
    default:
      return 'no-store';
  }
}

export function createBadgeService(deps: BadgeServiceDeps): Server {
  const now = deps.now ?? (() => new Date());
  const ttlVerified = deps.cacheTtlVerifiedMs ?? 300_000;
  const ttlNegative = deps.cacheTtlNegativeMs ?? 60_000;
  const staleCeiling = deps.staleOnErrorMs ?? 900_000;
  const rateMax = deps.rateLimitMax ?? 120;
  const rateWindow = deps.rateLimitWindowMs ?? 60_000;
  const maxConcurrent = deps.maxConcurrentLookups ?? 10;

  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<{ result: VerifyResult; stale: boolean }>>();
  const rateWindows = new Map<string, number[]>();
  let activeLookups = 0;
  const lookupQueue: Array<() => void> = [];
  const health = { agentBookReachable: true, lastLookupMs: null as number | null };

  function acquireLookup(): Promise<void> {
    if (activeLookups < maxConcurrent) {
      activeLookups++;
      return Promise.resolve();
    }
    return new Promise((resolve) => lookupQueue.push(resolve));
  }
  function releaseLookup(): void {
    const next = lookupQueue.shift();
    if (next) next();
    else activeLookups--;
  }

  function ttlFor(status: VerificationStatus): number {
    if (status === 'verified' || status === 'expired') return ttlVerified;
    if (status === 'unregistered' || status === 'invalid') return ttlNegative;
    return 0; // unknown is never cached (SPEC 4.6: a failure retries next request)
  }

  async function callCore(subjectType: string, subjectId: string): Promise<VerifyResult> {
    await acquireLookup();
    try {
      if (subjectType === 'address') {
        return await deps.verifier.resolveStatus({ kind: 'address', address: subjectId });
      }
      const resolver = deps.resolveAttestation ?? (async () => null);
      return await deps.verifier.resolveStatus({
        kind: 'attested_subject',
        subject: { type: subjectType, id: subjectId },
        resolveAttestation: resolver,
      });
    } finally {
      releaseLookup();
    }
  }

  async function resolveResult(
    subjectType: string,
    subjectId: string,
  ): Promise<{ result: VerifyResult; stale: boolean }> {
    const key = subjectType === 'address' ? `address:${subjectId.toLowerCase()}` : `${subjectType}:${subjectId}`;
    const nowMs = now().getTime();
    const entry = cache.get(key);
    if (entry && nowMs - entry.storedAtMs < ttlFor(entry.result.status)) {
      return { result: entry.result, stale: false };
    }
    const pending = inFlight.get(key);
    if (pending) return pending;
    const flight = (async () => {
      const result = await callCore(subjectType, subjectId);
      if (result.evidence.rpcLatencyMs !== undefined) health.lastLookupMs = result.evidence.rpcLatencyMs;
      const lookupFailed =
        result.status === 'unknown' &&
        (result.failures.includes('lookup_failed') || result.failures.includes('lookup_timeout'));
      if (lookupFailed || result.failures.includes('attestation_not_found')) {
        if (lookupFailed) health.agentBookReachable = false;
      } else {
        health.agentBookReachable = true;
      }
      // Stale-on-error (SPEC 4.6): a failed refresh may serve a cached
      // verified result younger than the ceiling, with its ORIGINAL
      // check time; older, or none, and the honest answer is unknown.
      if (lookupFailed && entry && entry.result.status === 'verified' && now().getTime() - entry.storedAtMs < staleCeiling) {
        return { result: entry.result, stale: true };
      }
      if (result.status !== 'unknown') {
        cache.set(key, { result, storedAtMs: now().getTime() });
      }
      return { result, stale: false };
    })();
    inFlight.set(key, flight);
    try {
      return await flight;
    } finally {
      inFlight.delete(key);
    }
  }

  function rateLimited(ip: string): boolean {
    const nowMs = now().getTime();
    const hits = (rateWindows.get(ip) ?? []).filter((t) => nowMs - t < rateWindow);
    hits.push(nowMs);
    rateWindows.set(ip, hits);
    return hits.length > rateMax;
  }

  function etagFor(parts: string[]): string {
    return `"${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)}"`;
  }

  function baseFrom(req: IncomingMessage): string {
    if (deps.publicBaseUrl) return deps.publicBaseUrl;
    const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
    const host = req.headers.host;
    return host ? `${proto}://${host}` : '';
  }

  function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  function sendBadge(
    res: ServerResponse,
    args: {
      status: VerificationStatus;
      stale: boolean;
      themeParam: string | null;
      variant: BadgeVariant;
      format: 'svg' | 'png';
      clientHint: string | undefined;
      checkedAt: string;
      subjectKey: string;
      forceNoStore?: boolean;
    },
  ): void {
    const state = stateForStatus(args.status);
    const theme: ThemeSelection =
      args.themeParam === 'dark' || args.themeParam === 'light' ? args.themeParam : 'auto';
    const headers: Record<string, string> = {
      'cache-control': args.forceNoStore || args.stale ? 'no-store' : cacheControlFor(args.status),
      'x-checked-at': args.checkedAt,
      'accept-ch': 'Sec-CH-Prefers-Color-Scheme',
    };
    if (args.format === 'svg') {
      headers['etag'] = etagFor([args.subjectKey, args.status, args.checkedAt, args.variant, theme]);
      const svg = renderBadgeSvg({ state, theme, variant: args.variant, checkedAt: args.checkedAt, now: now() });
      res.writeHead(200, { 'content-type': 'image/svg+xml', ...headers });
      res.end(svg);
      return;
    }
    // PNG: auto resolves server-side from the client hint, falling
    // back to dark, and reports the resolution (SPEC 4.2).
    const resolved: ThemeName =
      theme !== 'auto' ? theme : args.clientHint === 'light' ? 'light' : 'dark';
    headers['x-badge-theme'] = resolved;
    if (theme === 'auto') headers['vary'] = 'Sec-CH-Prefers-Color-Scheme';
    headers['etag'] = etagFor([
      args.subjectKey,
      args.status,
      args.checkedAt,
      args.variant,
      theme === 'auto' ? `auto:${resolved}` : theme,
    ]);
    const png = renderBadgePng({ state, theme: resolved, variant: args.variant, checkedAt: args.checkedAt, now: now() });
    res.writeHead(200, { 'content-type': 'image/png', ...headers });
    res.end(png);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://badge.local');
      const path = url.pathname;
      const ip = req.socket.remoteAddress ?? 'unknown';

      if (req.method !== 'GET') {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      if (path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(explainerHtml());
        return;
      }
      if (path === '/health') {
        sendJson(res, 200, {
          ok: true,
          agentBookReachable: health.agentBookReachable,
          lastLookupMs: health.lastLookupMs,
        });
        return;
      }

      const statusMatch = /^\/v1\/status\/([^/]+)\/([^/]+)$/.exec(path);
      const badgeMatch = /^\/badge\/([^/]+)\/([^/]+)\.(svg|png)$/.exec(path);
      const legacyMatch = /^\/badge\/([^/]+)\.(svg|png)$/.exec(path);

      if (statusMatch) {
        const subjectType = decodeURIComponent(statusMatch[1]!);
        const subjectId = decodeURIComponent(statusMatch[2]!);
        if (rateLimited(ip)) {
          sendJson(res, 429, { error: 'rate limit exceeded' }, { 'cache-control': 'no-store' });
          return;
        }
        // SPEC 4.2 step 1: a malformed address is a 400 on the JSON route.
        if (subjectType === 'address' && !ADDRESS_RE.test(subjectId)) {
          sendJson(res, 400, { error: 'malformed address subject' }, { 'cache-control': 'no-store' });
          return;
        }
        const { result, stale } = await resolveResult(subjectType, subjectId);
        const pub = toPublicVerifyResult(result);
        if (stale) pub.evidence = { ...pub.evidence, source: 'cache' };
        const body = {
          subject: { type: subjectType, id: subjectId },
          status: pub.status,
          addressTruncated: pub.addressTruncated,
          humanHash: pub.humanHash,
          failures: pub.failures,
          evidence: pub.evidence,
          checkedAt: pub.evidence.checkedAt,
          badge: badgeUrls(baseFrom(req), subjectType, subjectId),
        };
        sendJson(res, 200, body, {
          'cache-control': stale ? 'no-store' : cacheControlFor(result.status),
          etag: etagFor([`${subjectType}:${subjectId}`, result.status, pub.evidence.checkedAt, 'json']),
          'x-checked-at': pub.evidence.checkedAt,
        });
        return;
      }

      if (badgeMatch || legacyMatch) {
        const subjectType = badgeMatch ? decodeURIComponent(badgeMatch[1]!) : 'discord_application';
        const subjectId = badgeMatch ? decodeURIComponent(badgeMatch[2]!) : decodeURIComponent(legacyMatch![1]!);
        const format = (badgeMatch ? badgeMatch[3]! : legacyMatch![2]!) as 'svg' | 'png';
        const themeParam = url.searchParams.get('theme');
        const variant: BadgeVariant = url.searchParams.get('variant') === 'icon' ? 'icon' : 'pill';
        const checkedNow = now().toISOString();
        if (rateLimited(ip)) {
          // An embed never breaks a page layout because of limiting:
          // the unverified badge, no-store (SPEC 4.7).
          sendBadge(res, {
            status: 'unknown', stale: false, themeParam, variant, format,
            clientHint: req.headers['sec-ch-prefers-color-scheme'] as string | undefined,
            checkedAt: checkedNow, subjectKey: `${subjectType}:${subjectId}`, forceNoStore: true,
          });
          return;
        }
        // Malformed subject: an <img> cannot usefully show a 400, so
        // the badge routes render unverified with no-store (SPEC 4.2).
        if (subjectType === 'address' && !ADDRESS_RE.test(subjectId)) {
          sendBadge(res, {
            status: 'invalid', stale: false, themeParam, variant, format,
            clientHint: req.headers['sec-ch-prefers-color-scheme'] as string | undefined,
            checkedAt: checkedNow, subjectKey: `${subjectType}:${subjectId}`, forceNoStore: true,
          });
          return;
        }
        const { result, stale } = await resolveResult(subjectType, subjectId);
        sendBadge(res, {
          status: result.status, stale, themeParam, variant, format,
          clientHint: req.headers['sec-ch-prefers-color-scheme'] as string | undefined,
          checkedAt: result.evidence.checkedAt, subjectKey: `${subjectType}:${subjectId}`,
        });
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch {
      // Internal fault only (SPEC 4.7): a dead RPC is a grey badge,
      // never a 500; a 500 here means rendering itself failed. The
      // body carries no internals.
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    }
  });

  return server;
}
