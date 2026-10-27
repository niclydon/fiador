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
//
// Every keyed structure in this service (result cache,
// single-flight map, registry, ETags, render cache) keys a subject
// by the JSON encoding of its [type, id] pair (config.ts
// subjectKey). Separator concatenation is not a key: distinct
// subjects must never share an entry anywhere.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import {
  toPublicVerifyResult,
  truncateAddress,
  type EvmAddress,
  type SignedAttestation,
  type VerificationStatus,
  type VerifyResult,
  type Verifier,
} from '@fiador/verify';
import { canonicalSubject, subjectKey, type RegistrySource } from './config.js';
import { explainerHtml } from './explainer.js';
import { stateForStatus, type BadgeVariant, type ThemeName } from './palettes.js';
import { renderBadgePng, renderBadgeSvg, type ThemeSelection } from './render.js';

export interface BadgeServiceDeps {
  verifier: Verifier;
  /** Subject -> attestation resolver (registry-backed in deployed
   * configuration; see config.ts). Absent, every attested subject
   * resolves as not found. */
  resolveAttestation?: (subject: { type: string; id: string }) => Promise<SignedAttestation | null>;
  /** Refreshing registry source (config.ts FileRegistry). When
   * present it is the resolver, and it is refreshed on its cadence
   * as requests arrive (SPEC 4.6). */
  registrySource?: RegistrySource;
  /** Absolute public base URL for badge URLs in the JSON route,
   * from configuration ONLY. Request headers (Host,
   * X-Forwarded-Proto) are never used to build URLs: a poisoned
   * Host must not be able to mint badge URLs the service then
   * blesses with public cache headers. Absent, badge URLs are
   * path-relative (no scheme, no host). */
  publicBaseUrl?: string;
  now?: () => Date;
  /** Trust X-Forwarded-For for rate-limit keying. Default false:
   * the limiter keys on the socket address. Enable ONLY when the
   * service sits behind a trusted proxy that sets the header —
   * otherwise the header is client-controlled and the limiter is
   * decorative. (Mirrored in the README.) */
  /** SPEC 4.6 proposals, as configuration (not code constants). */
  cacheTtlVerifiedMs?: number; // verified + expired, default 300_000
  cacheTtlNegativeMs?: number; // unregistered + invalid, default 60_000
  staleOnErrorMs?: number; // stale verified ceiling, default 900_000
  /** Result-cache bound (entries). An LRU at this cap holds every
   * cached outcome, negatives included; default 1000. */
  cacheMaxEntries?: number;
  /** Rendered-badge cache bound (entries); default 500. */
  renderCacheMaxEntries?: number;
  rateLimitMax?: number; // per key per window, default 120
  rateLimitWindowMs?: number; // default 60_000
  /** Exact IPs of reverse proxies that append X-Forwarded-For. */
  trustedProxyIps?: readonly string[];
  maxConcurrentLookups?: number; // outbound core-call cap, default 10
  lookupQueueMax?: number; // queued lookups awaiting a slot, default 100
  lookupDeadlineMs?: number; // per-lookup queue+call deadline, default 10_000
  requestTimeoutMs?: number; // total source + core deadline, capped at 5000
  headersTimeoutMs?: number; // HTTP headers timeout, default 15_000
  agentBookContract?: EvmAddress;
  /** Test seam: invoked once per actual badge render (SVG build or
   * PNG rasterisation), so tests can prove cost is shed. */
  onRender?: (kind: 'svg' | 'png') => void;
}

interface CacheEntry {
  result: VerifyResult;
  storedAtMs: number;
  sourceFingerprint: string;
}

interface SourceFlight {
  promise: Promise<{ attestation: SignedAttestation | null; failed: boolean }>;
  controller: AbortController;
  started: { value: boolean };
  waiters: number;
}

interface RenderEntry {
  body: Buffer;
  etag: string;
  resolvedTheme: ThemeName | undefined;
  reuseUntilMs: number;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_TYPE_LENGTH = 64; // aligned with the core's subject limits
const MAX_ID_LENGTH = 256;
const ZERO_ADDRESS: EvmAddress = '0x0000000000000000000000000000000000000000';
const AGENTBOOK_CONTRACT: EvmAddress = '0xA23aB2712eA7BBa896930544C7d6636a96b944dA';

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
export function cacheControlFor(status: VerificationStatus, remainingMs?: number): string {
  if (status === 'unknown') return 'no-store';
  const limit = status === 'verified' || status === 'expired' ? 300_000 : 60_000;
  const seconds = Math.max(0, Math.floor(Math.min(limit, remainingMs ?? limit) / 1000));
  if (seconds === 0) return 'no-store';
  switch (status) {
    case 'verified':
      return `public, max-age=${seconds}, s-maxage=${seconds}`;
    case 'expired':
      return `public, max-age=${seconds}, s-maxage=${seconds}`;
    case 'unregistered':
    case 'invalid':
      return `public, max-age=${seconds}, s-maxage=${seconds}`;
    default:
      return 'no-store';
  }
}

/** Bounded LRU: a plain Map in insertion order, refreshed on read,
 * evicting the oldest entry past the cap. */
class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private readonly maxEntries: number) {}
  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }
  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  delete(key: string): void {
    this.map.delete(key);
  }
  get size(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
}

class OverloadedError extends Error {
  constructor() {
    super('lookup capacity exceeded');
    this.name = 'OverloadedError';
  }
}

export interface BadgeServiceInternals {
  resultCacheSize(): number;
  renderCacheSize(): number;
}

export function createBadgeService(deps: BadgeServiceDeps): Server & { badgeInternals: BadgeServiceInternals } {
  const now = deps.now ?? (() => new Date());
  const ttlVerified = Math.min(deps.cacheTtlVerifiedMs ?? 300_000, 300_000);
  const ttlNegative = Math.min(deps.cacheTtlNegativeMs ?? 60_000, 60_000);
  const staleCeiling = Math.min(deps.staleOnErrorMs ?? 900_000, 900_000);
  const rateMax = deps.rateLimitMax ?? 120;
  const rateWindow = deps.rateLimitWindowMs ?? 60_000;
  const maxConcurrent = deps.maxConcurrentLookups ?? 10;
  const queueMax = deps.lookupQueueMax ?? 100;
  const lookupDeadline = deps.lookupDeadlineMs ?? 10_000;
  const requestTimeoutMs = Math.min(deps.requestTimeoutMs ?? 5_000, 5_000);

  const cache = new LruCache<CacheEntry>(deps.cacheMaxEntries ?? 1000);
  const renderCache = new LruCache<RenderEntry>(deps.renderCacheMaxEntries ?? 500);
  /** Last render per route shape, for shedding rate-limited load:
   * a limited request serves this instead of rasterising. */
  const lastRender = new LruCache<RenderEntry>(deps.renderCacheMaxEntries ?? 500);
  const inFlight = new Map<string, Promise<{ result: VerifyResult; stale: boolean; storedAtMs: number }>>();
  const sourceInFlight = new Map<string, SourceFlight>();
  const rateWindows = new Map<string, number[]>();
  const health = { agentBookReachable: true, lastLookupMs: null as number | null };

  let activeLookups = 0;
  interface Queued {
    grant: () => void;
    fail: (err: Error) => void;
    settled: boolean;
  }
  const lookupQueue: Queued[] = [];

  function acquireLookup(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new OverloadedError());
        return;
      }
      if (activeLookups < maxConcurrent) {
        activeLookups++;
        resolve();
        return;
      }
      if (lookupQueue.length >= queueMax) {
        reject(new OverloadedError());
        return;
      }
      const entry: Queued = {
        settled: false,
        grant: () => {
          if (entry.settled) return;
          entry.settled = true;
          activeLookups++;
          resolve();
        },
        fail: (err) => {
          if (entry.settled) return;
          entry.settled = true;
          reject(err);
        },
      };
      signal.addEventListener('abort', () => entry.fail(new OverloadedError()), { once: true });
      lookupQueue.push(entry);
    });
  }
  function releaseLookup(): void {
    activeLookups--;
    while (lookupQueue.length > 0) {
      const next = lookupQueue.shift()!;
      if (next.settled) continue;
      next.grant();
      break;
    }
  }

  function ttlFor(status: VerificationStatus): number {
    if (status === 'verified' || status === 'expired') return ttlVerified;
    if (status === 'unregistered' || status === 'invalid') return ttlNegative;
    return 0; // unknown is never cached (SPEC 4.6: a failure retries next request)
  }

  async function callCore(
    subjectType: string,
    subjectId: string,
    attestation: SignedAttestation | null,
    sourceFailed: boolean,
    signal: AbortSignal,
  ): Promise<VerifyResult> {
    await acquireLookup(signal);
    try {
      if (canonicalSubject(subjectType, subjectId)[0] === 'address') {
        return await deps.verifier.resolveStatus(
          { kind: 'address', address: subjectId },
          { signal },
        );
      }
      return await deps.verifier.resolveStatus(
        {
          kind: 'attested_subject',
          subject: { type: subjectType, id: subjectId },
          resolveAttestation: async () => {
            if (sourceFailed) throw new Error('attestation source unavailable');
            return attestation;
          },
        },
        { signal },
      );
    } finally {
      releaseLookup();
    }
  }

  async function resolveSource(key: string, subjectType: string, subjectId: string, signal: AbortSignal): Promise<{ attestation: SignedAttestation | null; failed: boolean }> {
    if (signal.aborted) throw new Error('request deadline exceeded');
    let flight = sourceInFlight.get(key);
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController();
      const started = { value: false };
      const promise = (async () => {
        let acquired = false;
        try {
          await acquireLookup(controller.signal);
          acquired = true;
          if (controller.signal.aborted) throw new Error('lookup cancelled');
          started.value = true;
          const resolver = deps.registrySource?.resolve.bind(deps.registrySource) ?? deps.resolveAttestation ?? (async () => null);
          const attestation = await resolver({ type: subjectType, id: subjectId });
          return { attestation, failed: false };
        } catch {
          return { attestation: null, failed: true };
        } finally {
          if (acquired) releaseLookup();
        }
      })();
      flight = { promise, controller, started, waiters: 0 };
      sourceInFlight.set(key, flight);
      const current = flight;
      void promise.then(() => {
        if (sourceInFlight.get(key) === current) sourceInFlight.delete(key);
      });
    }
    const joined = flight;
    joined.waiters++;
    let waiting = true;
    const leave = () => {
      if (!waiting) return;
      waiting = false;
      signal.removeEventListener('abort', leave);
      joined.waiters--;
      // A running resolver may still finish and serve a later caller.
      // A queued resolver with no callers must never consume a slot.
      if (joined.waiters === 0 && !joined.started.value) joined.controller.abort();
    };
    signal.addEventListener('abort', leave, { once: true });
    if (signal.aborted) leave();
    try {
      return await joined.promise;
    } finally {
      leave();
    }
  }

  let lastRegistryVersion = deps.registrySource?.version ?? 0;

  async function resolveResult(
    subjectType: string,
    subjectId: string,
    signal: AbortSignal,
  ): Promise<{ result: VerifyResult; stale: boolean; storedAtMs: number }> {
    deps.registrySource?.refreshIfDue(now().getTime());
    const registryVersion = deps.registrySource?.version ?? 0;
    if (registryVersion !== lastRegistryVersion) {
      // The registry content changed under us (SPEC 4.6 refresh):
      // results and renders cached against the old registry are
      // dropped, so a removed or replaced attestation takes
      // effect now, not at cache expiry.
      lastRegistryVersion = registryVersion;
      cache.clear();
      renderCache.clear();
      lastRender.clear();
    }
    const key = subjectKey(subjectType, subjectId);
    const nowMs = now().getTime();
    const source = subjectType === 'address'
      ? { attestation: null, failed: false }
      : await resolveSource(key, subjectType, subjectId, signal);
    if (signal.aborted) throw new Error('request deadline exceeded');
    const { attestation, failed: sourceFailed } = source;
    // Read the source before using the result cache. A removed or
    // replaced registry entry must not inherit the old verified result.
    const sourceFingerprint = subjectType === 'address'
      ? 'address'
      : sourceFailed ? 'source-error' : attestation
        ? createHash('sha256').update(JSON.stringify(attestation)).digest('hex') : 'missing';
    let entry = cache.get(key);
    if (!sourceFailed && entry && entry.sourceFingerprint !== sourceFingerprint) {
      cache.delete(key);
      entry = undefined;
    }
    if (!sourceFailed && entry && nowMs - entry.storedAtMs < ttlFor(entry.result.status)) {
      return { result: entry.result, stale: false, storedAtMs: entry.storedAtMs };
    }
    const flightKey = JSON.stringify([key, sourceFingerprint]);
    const pending = inFlight.get(flightKey);
    if (pending) return pending;
    const flight = (async () => {
      // One deadline covers queue wait + the core call; its signal
      // is what the core receives, so a queued-then-expired lookup
      // aborts the RPC instead of running unbounded.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), lookupDeadline);
      let result: VerifyResult;
      try {
        result = await callCore(subjectType, subjectId, attestation, sourceFailed, controller.signal);
      } catch (err) {
        if (err instanceof OverloadedError) throw err;
        throw err;
      } finally {
        clearTimeout(timer);
      }
      if (result.evidence.rpcLatencyMs !== undefined) health.lastLookupMs = result.evidence.rpcLatencyMs;
      const lookupFailed =
        result.status === 'unknown' &&
        (result.failures.includes('lookup_failed') || result.failures.includes('lookup_timeout'));
      if (lookupFailed || result.failures.includes('attestation_not_found')) {
        if (lookupFailed && !sourceFailed) health.agentBookReachable = false;
      } else {
        health.agentBookReachable = true;
      }
      // Stale-on-error (SPEC 4.6): a failed refresh may serve a cached
      // verified result younger than the ceiling, with its ORIGINAL
      // check time; older, or none, and the honest answer is unknown.
      if (lookupFailed && entry && entry.result.status === 'verified' && now().getTime() - entry.storedAtMs < staleCeiling) {
        return { result: entry.result, stale: true, storedAtMs: entry.storedAtMs };
      }
      if (!sourceFailed && ttlFor(result.status) > 0) {
        cache.set(key, { result, storedAtMs: now().getTime(), sourceFingerprint });
      }
      return { result, stale: false, storedAtMs: nowMs };
    })();
    inFlight.set(flightKey, flight);
    try {
      return await flight;
    } finally {
      inFlight.delete(flightKey);
    }
  }

  function timeoutResult(subjectType: string, subjectId: string): VerifyResult {
    const address = subjectType === 'address' ? subjectId as EvmAddress : ZERO_ADDRESS;
    return {
      status: 'unknown',
      address,
      addressTruncated: truncateAddress(address),
      humanHash: null,
      failures: ['lookup_timeout'],
      evidence: {
        checkedAt: now().toISOString(),
        source: 'live',
        agentBook: { network: 'eip155:480', contract: deps.agentBookContract ?? AGENTBOOK_CONTRACT },
      },
    };
  }

  async function resolveWithDeadline(subjectType: string, subjectId: string): Promise<{ result: VerifyResult; stale: boolean; storedAtMs: number }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ result: VerifyResult; stale: boolean; storedAtMs: number }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ result: timeoutResult(subjectType, subjectId), stale: false, storedAtMs: now().getTime() });
      }, requestTimeoutMs);
    });
    try {
      return await Promise.race([resolveResult(subjectType, subjectId, controller.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function rateKey(req: IncomingMessage): string {
    const peer = req.socket.remoteAddress ?? 'unknown';
    if (!deps.trustedProxyIps?.includes(peer)) return peer;
    const forwarded = req.headers['x-forwarded-for'];
    // The nearest trusted proxy appends the actual peer on the right.
    const candidate = typeof forwarded === 'string' ? forwarded.split(',').at(-1)?.trim() : undefined;
    return candidate && isIP(candidate) ? candidate : peer;
  }

  function rateLimited(key: string): boolean {
    const nowMs = now().getTime();
    const hits = (rateWindows.get(key) ?? []).filter((t) => nowMs - t < rateWindow);
    hits.push(nowMs);
    if (hits.length === 0) rateWindows.delete(key);
    else rateWindows.set(key, hits);
    if (rateWindows.size > 10_000) {
      for (const [k, v] of rateWindows) {
        if (v.every((t) => nowMs - t >= rateWindow)) rateWindows.delete(k);
      }
    }
    return hits.length > rateMax;
  }

  function etagFor(parts: unknown[]): string {
    return `"${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}"`;
  }

  function ifNoneMatchHits(req: IncomingMessage, etag: string): boolean {
    const header = req.headers['if-none-match'];
    if (!header) return false;
    return header
      .split(',')
      .map((t) => t.trim())
      .some((t) => t === '*' || t === etag || t === `W/${etag}`);
  }

  /** The effective badge base: configuration only, never request
   * headers. Empty string yields path-relative URLs. */
  function effectiveBase(): string {
    return deps.publicBaseUrl ?? '';
  }

  function sendJson(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
    head = false,
  ): void {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(head ? undefined : text);
  }

  interface BadgeArgs {
    status: VerificationStatus;
    stale: boolean;
    theme: ThemeSelection;
    variant: BadgeVariant;
    format: 'svg' | 'png';
    clientHint: string | undefined;
    /** ISO check time from the core, or null when no check ran:
     * the badge then shows no check time and no X-Checked-At is
     * emitted (SPEC 4.4 evidence rule). */
    checkedAt: string | null;
    subjectKeyValue: string;
    forceNoStore?: boolean;
    labelOverride?: string;
    cacheControl?: string;
    reuseUntilMs?: number;
  }

  /** Returns true when a response was sent. Honours the render
   * cache and If-None-Match BEFORE any rendering happens, so a
   * conditional or repeated request never pays rasterisation. */
  function sendBadge(req: IncomingMessage, res: ServerResponse, args: BadgeArgs, head: boolean): void {
    const state = stateForStatus(args.status);
    const base = effectiveBase();
    // For the auto PNG the resolved theme is part of the render
    // identity; for everything else the requested theme is.
    const resolved: ThemeName | undefined =
      args.format === 'png'
        ? args.theme !== 'auto'
          ? args.theme
          : args.clientHint === 'light'
            ? 'light'
            : 'dark'
        : undefined;
    const themeKey =
      args.format === 'png' && args.theme === 'auto' ? `auto:${resolved}` : args.theme;
    const etag = etagFor([
      args.subjectKeyValue,
      args.status,
      args.checkedAt,
      args.variant,
      args.format,
      themeKey,
      base,
      args.labelOverride ?? '',
    ]);
    const headers: Record<string, string> = {
      'cache-control': args.forceNoStore || args.stale ? 'no-store' : args.cacheControl ?? cacheControlFor(args.status),
      etag,
      'accept-ch': 'Sec-CH-Prefers-Color-Scheme',
    };
    if (args.checkedAt !== null) headers['x-checked-at'] = args.checkedAt;
    if (args.format === 'png') {
      headers['content-type'] = 'image/png';
      headers['x-badge-theme'] = resolved!;
      if (args.theme === 'auto') headers['vary'] = 'Sec-CH-Prefers-Color-Scheme';
    } else {
      headers['content-type'] = 'image/svg+xml';
    }

    const renderKey = etag; // the ETag IS the render identity
    const routeKey = JSON.stringify([args.subjectKeyValue, args.variant, args.format, themeKey]);

    if (ifNoneMatchHits(req, etag)) {
      // A conditional hit is answered from the ETag alone: no
      // render, and the cached render (if any) stays authoritative.
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const cached = renderCache.get(renderKey);
    if (cached) {
      res.writeHead(200, headers);
      res.end(head ? undefined : cached.body);
      return;
    }
    // Render exactly once per unique badge state; the render cache
    // and the per-route last-render both learn it.
    deps.onRender?.(args.format);
    const body =
      args.format === 'svg'
        ? Buffer.from(
            renderBadgeSvg({ state, theme: args.theme, variant: args.variant, checkedAt: args.checkedAt, now: now(), ...(args.labelOverride ? { labelOverride: args.labelOverride } : {}) }),
            'utf8',
          )
        : renderBadgePng({ state, theme: resolved!, variant: args.variant, checkedAt: args.checkedAt, now: now(), ...(args.labelOverride ? { labelOverride: args.labelOverride } : {}) });
    const entry: RenderEntry = { body, etag, resolvedTheme: resolved, reuseUntilMs: args.reuseUntilMs ?? 0 };
    renderCache.set(renderKey, entry);
    lastRender.set(routeKey, entry);
    res.writeHead(200, headers);
    res.end(head ? undefined : body);
  }

  /** A limited request may reuse an observed badge only within its
   * original check's TTL. Once that expires, show unchecked art; an
   * old verified image must never survive indefinitely under load. */
  const busyPng = new Map<string, Buffer>();
  function sendLimitedBadge(
    req: IncomingMessage,
    res: ServerResponse,
    args: Omit<BadgeArgs, 'status' | 'checkedAt' | 'stale'>,
    head: boolean,
  ): void {
    const themeKey =
      args.format === 'png' && args.theme === 'auto'
        ? `auto:${args.clientHint === 'light' ? 'light' : 'dark'}`
        : args.theme;
    const routeKey = JSON.stringify([args.subjectKeyValue, args.variant, args.format, themeKey]);
    const last = lastRender.get(routeKey);
    const headers: Record<string, string> = { 'cache-control': 'no-store' };
    if (last && now().getTime() < last.reuseUntilMs) {
      headers['content-type'] = args.format === 'png' ? 'image/png' : 'image/svg+xml';
      if (args.format === 'png') headers['x-badge-theme'] = last.resolvedTheme ?? 'dark';
      if (args.format === 'png' && args.theme === 'auto') headers.vary = 'Sec-CH-Prefers-Color-Scheme';
      res.writeHead(200, headers);
      res.end(head ? undefined : last.body);
      return;
    }
    if (last) lastRender.delete(routeKey);
    // Nothing rendered yet for this route: the unchecked badge,
    // built without the rasteriser where possible.
    if (args.format === 'svg') {
      deps.onRender?.('svg');
      const svg = renderBadgeSvg({
        state: 'unverified',
        theme: args.theme,
        variant: args.variant,
        checkedAt: null,
        now: now(),
      });
      res.writeHead(200, { 'content-type': 'image/svg+xml', ...headers });
      res.end(head ? undefined : svg);
      return;
    }
    const resolvedTheme: ThemeName = args.theme === 'auto'
      ? args.clientHint === 'light' ? 'light' : 'dark'
      : args.theme;
    const fallbackKey = JSON.stringify([args.variant, resolvedTheme]);
    let png = busyPng.get(fallbackKey);
    if (!png) {
      deps.onRender?.('png');
      png = renderBadgePng({
        state: 'unverified',
        theme: resolvedTheme,
        variant: args.variant,
        checkedAt: null,
        now: now(),
      });
      busyPng.set(fallbackKey, png);
    }
    headers['content-type'] = 'image/png';
    headers['x-badge-theme'] = resolvedTheme;
    if (args.theme === 'auto') headers.vary = 'Sec-CH-Prefers-Color-Scheme';
    res.writeHead(200, headers);
    res.end(head ? undefined : png);
  }

  function uncheckedBadge(
    req: IncomingMessage,
    res: ServerResponse,
    args: Omit<BadgeArgs, 'status' | 'checkedAt' | 'stale'>,
    head: boolean,
  ): void {
    sendBadge(req, res, { ...args, status: 'invalid', checkedAt: null, stale: false, forceNoStore: true }, head);
  }

  type ParsedSubject =
    | { ok: true; type: string; id: string }
    | { ok: false; reason: 'malformed-encoding' | 'too-long' | 'empty' | 'malformed-address' };

  function validateSubject(type: string, id: string): ParsedSubject {
    if (type.length === 0 || id.length === 0) return { ok: false, reason: 'empty' };
    if (type.length > MAX_TYPE_LENGTH || id.length > MAX_ID_LENGTH) return { ok: false, reason: 'too-long' };
    if (canonicalSubject(type, id)[0] === 'address' && !ADDRESS_RE.test(id)) {
      return { ok: false, reason: 'malformed-address' };
    }
    return { ok: true, type, id };
  }

  function decodeSegment(raw: string): string | null {
    try {
      return decodeURIComponent(raw);
    } catch {
      return null; // malformed percent-encoding (SPEC 4.7 treatment, never a 500)
    }
  }

  const server = createServer(async (req, res) => {
    const head = req.method === 'HEAD';
    try {
      const url = new URL(req.url ?? '/', 'http://badge.local');
      const path = url.pathname;

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
        return;
      }
      if (path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(head ? undefined : explainerHtml());
        return;
      }
      if (path === '/health') {
        sendJson(res, 200, {
          ok: true,
          agentBookReachable: health.agentBookReachable,
          lastLookupMs: health.lastLookupMs,
        }, {}, head);
        return;
      }

      const isStatusPath = path === '/v1/status' || path.startsWith('/v1/status/');
      const isBadgePath = path === '/badge' || path.startsWith('/badge/');

      if (isStatusPath) {
        const segments = path.split('/').slice(3); // after /v1/status
        if (segments.length !== 2) {
          sendJson(res, 400, { error: 'malformed subject' }, { 'cache-control': 'no-store' }, head);
          return;
        }
        const type = decodeSegment(segments[0]!);
        const id = decodeSegment(segments[1]!);
        if (type === null || id === null) {
          sendJson(res, 400, { error: 'malformed subject encoding' }, { 'cache-control': 'no-store' }, head);
          return;
        }
        if (rateLimited(rateKey(req))) {
          sendJson(res, 429, { error: 'rate limit exceeded' }, { 'cache-control': 'no-store' }, head);
          return;
        }
        const parsed = validateSubject(type, id);
        if (!parsed.ok) {
          sendJson(
            res,
            400,
            { error: parsed.reason === 'malformed-address' ? 'malformed address subject' : 'malformed subject' },
            { 'cache-control': 'no-store' },
            head,
          );
          return;
        }
        let resolvedResult: { result: VerifyResult; stale: boolean; storedAtMs: number };
        try {
          resolvedResult = await resolveWithDeadline(parsed.type, parsed.id);
        } catch (err) {
          if (err instanceof OverloadedError) {
            sendJson(res, 503, { error: 'service busy' }, { 'cache-control': 'no-store' }, head);
            return;
          }
          throw err;
        }
        const { result, stale, storedAtMs } = resolvedResult;
        const pub = toPublicVerifyResult(result);
        if (stale) pub.evidence = { ...pub.evidence, source: 'cache' };
        // Address-subject disclosure rule (spec reconciliation):
        // the queried address appears ONCE in this body, as the
        // explicit subject echo below. Every other field carries
        // the truncated form only. A badge URL requires the full
        // address to work, so this response omits address badge URLs
        // rather than publishing a dead link or leaking the address
        // through a URL (SPEC 4.9).
        const [canonType] = canonicalSubject(parsed.type, parsed.id);
        const body = {
          subject: { type: parsed.type, id: parsed.id },
          status: pub.status,
          addressTruncated: pub.addressTruncated,
          humanHash: pub.humanHash,
          failures: pub.failures,
          evidence: pub.evidence,
          checkedAt: pub.evidence.checkedAt,
          badge: canonType === 'address' ? null : badgeUrls(effectiveBase(), parsed.type, parsed.id),
        };
        const text = JSON.stringify(body);
        const etag = etagFor(['status-json', text]);
        const headers: Record<string, string> = {
          'cache-control': stale || parsed.type === 'discord_application'
            ? 'no-store' : cacheControlFor(result.status, ttlFor(result.status) - (now().getTime() - storedAtMs)),
          etag,
          'x-checked-at': pub.evidence.checkedAt,
        };
        if (ifNoneMatchHits(req, etag)) {
          res.writeHead(304, headers);
          res.end();
          return;
        }
        sendJson(res, 200, text, headers, head);
        return;
      }

      if (isBadgePath) {
        const themeRaw = url.searchParams.get('theme');
        const variantRaw = url.searchParams.get('variant');
        if (themeRaw !== null && themeRaw !== 'auto' && themeRaw !== 'dark' && themeRaw !== 'light') {
          sendJson(res, 400, { error: 'invalid theme' }, { 'cache-control': 'no-store' }, head);
          return;
        }
        if (variantRaw !== null && variantRaw !== 'pill' && variantRaw !== 'icon') {
          sendJson(res, 400, { error: 'invalid variant' }, { 'cache-control': 'no-store' }, head);
          return;
        }
        const theme = (themeRaw ?? 'auto') as ThemeSelection;
        const variant = (variantRaw ?? 'pill') as BadgeVariant;
        const clientHint = req.headers['sec-ch-prefers-color-scheme'] as string | undefined;

        // Lenient segment parse: near-misses (empty ID, uppercase
        // extension, trailing slash, bad percent-encoding) get the
        // SPEC 4.2/4.7 badge treatment — a grey no-store badge —
        // never a 500 and never another subject's result.
        const trimmed = path.replace(/\/$/, '');
        const segments = trimmed.split('/').slice(2); // after /badge
        let type: string | null = null;
        let id: string | null = null;
        let format: 'svg' | 'png' = 'svg';
        let wellFormed = false;
        const lastSeg = segments[segments.length - 1] ?? '';
        const extMatch = /\.([A-Za-z]+)$/.exec(lastSeg);
        // Near-misses are grey, not silently repaired: an uppercase
        // extension or a trailing slash does not serve the real
        // badge (the format guess only picks the grey badge's type).
        const nearMiss = trimmed !== path || (extMatch !== null && extMatch[1] !== 'svg' && extMatch[1] !== 'png');
        if (extMatch && extMatch[1]!.toLowerCase() === 'png') format = 'png';
        if (!nearMiss && extMatch && (extMatch[1] === 'svg' || extMatch[1] === 'png')) {
          format = extMatch[1] as 'svg' | 'png';
          const stem = lastSeg.slice(0, lastSeg.length - extMatch[0].length);
          if (segments.length === 1) {
            // Legacy alias: /badge/<id>.<ext> is discord_application.
            type = 'discord_application';
            id = decodeSegment(stem);
            wellFormed = id !== null && id.length > 0;
          } else if (segments.length === 2) {
            type = decodeSegment(segments[0]!);
            id = decodeSegment(stem);
            wellFormed = type !== null && id !== null;
          }
        }
        const greyKey = subjectKey(type ?? '?', id ?? '?');
        if (!wellFormed || type === null || id === null) {
          uncheckedBadge(req, res, { theme, variant, format, clientHint, subjectKeyValue: greyKey }, head);
          return;
        }
        const key = subjectKey(type, id);
        if (rateLimited(rateKey(req))) {
          sendLimitedBadge(req, res, { theme, variant, format, clientHint, subjectKeyValue: key }, head);
          return;
        }
        const parsed = validateSubject(type, id);
        if (!parsed.ok) {
          uncheckedBadge(req, res, { theme, variant, format, clientHint, subjectKeyValue: key }, head);
          return;
        }
        let resolvedResult: { result: VerifyResult; stale: boolean; storedAtMs: number };
        try {
          resolvedResult = await resolveWithDeadline(parsed.type, parsed.id);
        } catch (err) {
          if (err instanceof OverloadedError) {
            uncheckedBadge(req, res, { theme, variant, format, clientHint, subjectKeyValue: key }, head);
            return;
          }
          throw err;
        }
        const { result, stale, storedAtMs } = resolvedResult;
        const claimUnconfirmed = parsed.type === 'discord_application' && result.status === 'verified';
        const checkedAtMs = Date.parse(result.evidence.checkedAt);
        const reuseUntilMs = stale || !Number.isFinite(checkedAtMs)
          ? 0
          : Math.min(storedAtMs, checkedAtMs) + ttlFor(result.status);
        sendBadge(
          req,
          res,
          {
            status: claimUnconfirmed ? 'unknown' : result.status,
            stale,
            theme,
            variant,
            format,
            clientHint,
            checkedAt: result.evidence.checkedAt,
            subjectKeyValue: key,
            forceNoStore: parsed.type === 'discord_application',
            cacheControl: cacheControlFor(result.status, ttlFor(result.status) - (now().getTime() - storedAtMs)),
            reuseUntilMs,
            ...(claimUnconfirmed ? { labelOverride: 'Claim unconfirmed' } : {}),
          },
          head,
        );
        return;
      }

      sendJson(res, 404, { error: 'not found' }, {}, head);
    } catch {
      // Internal fault only (SPEC 4.7): a dead RPC is a grey badge,
      // never a 500; a 500 here means rendering itself failed. The
      // body carries no internals, and no subject-derived data.
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    }
  });

  // Explicit server timeouts: a slow-loris or a hung peer must not
  // hold sockets forever (defaults are configuration, SPEC 4.8).
  server.requestTimeout = deps.requestTimeoutMs ?? 30_000;
  server.headersTimeout = deps.headersTimeoutMs ?? 15_000;
  server.keepAliveTimeout = 5_000;

  const service = server as Server & { badgeInternals: BadgeServiceInternals };
  service.badgeInternals = {
    resultCacheSize: () => cache.size,
    renderCacheSize: () => renderCache.size,
  };
  return service;
}
