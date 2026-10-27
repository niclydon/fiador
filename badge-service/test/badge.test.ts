import { PNG } from 'pngjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createVerifier, hashHumanId, type SignedAttestation, type VerifyResult, type Verifier } from '@fiador/verify';
import { createBadgeService, type BadgeServiceDeps } from '../src/service.js';
import { ConfigError, FileRegistry, depsFromEnv, hostFromEnv, portFromEnv, type RegistrySource } from '../src/config.js';
import { createRegistryResolver } from '../src/registry.js';
import { formatCheckedLabel } from '../src/render.js';
import { PILL_PALETTES, type BadgeState } from '../src/palettes.js';

// Synthetic fixture values only (SPEC 7.1): an invented humanId in
// the right format, never a recorded one. The fake verifier's
// internal results deliberately CARRY the raw value, so the leak
// scans below prove the service's projection drops it.
const RAW_HUMAN = `0x${'a1'.repeat(32)}`;
const ADDR = '0x1234567890AbcdEF1234567890AbcdEF12345678';
const TRUNC = '0x1234…45678';
const ZERO = '0x0000000000000000000000000000000000000000';
const CONTRACT = '0xA23aB2712eA7BBa896930544C7d6636a96b944dA';
const T0 = new Date('2026-10-26T14:03:00.000Z');

const nowRef = { current: new Date(T0) };

type Mode = 'verified' | 'expired' | 'unregistered' | 'invalid' | 'unknown';

function resultFor(mode: Mode): VerifyResult {
  const base: VerifyResult = {
    status: 'verified',
    address: ADDR as VerifyResult['address'],
    addressTruncated: TRUNC,
    humanHash: hashHumanId(RAW_HUMAN),
    humanId: RAW_HUMAN,
    failures: [],
    evidence: {
      checkedAt: nowRef.current.toISOString(),
      source: 'live',
      agentBook: { network: 'eip155:480', contract: CONTRACT as VerifyResult['address'] },
      rpcLatencyMs: 7,
    },
  };
  switch (mode) {
    case 'verified':
      return base;
    case 'expired':
      return { ...base, status: 'expired', humanHash: null, failures: ['expired'] };
    case 'unregistered':
      return { ...base, status: 'unregistered', humanHash: null, failures: ['not_registered'] };
    case 'invalid':
      return { ...base, status: 'invalid', humanHash: null, failures: ['signature_mismatch'] };
    case 'unknown':
      return { ...base, status: 'unknown', humanHash: null, failures: ['lookup_failed'] };
  }
}

class FakeVerifier implements Verifier {
  calls = 0;
  attestationMode: Mode = 'verified';
  addressMode: Mode = 'verified';
  async verifyAddress(): Promise<VerifyResult> {
    throw new Error('service must use resolveStatus');
  }
  async verifyAttestation(): Promise<VerifyResult> {
    throw new Error('service must use resolveStatus');
  }
  async resolveStatus(subject: Parameters<Verifier['resolveStatus']>[0]): Promise<VerifyResult> {
    this.calls++;
    if (subject.kind === 'address') return resultFor(this.addressMode);
    if (subject.kind === 'attestation') return resultFor(this.attestationMode);
    const att = await subject.resolveAttestation(subject.subject);
    if (!att) {
      return {
        status: 'unknown',
        address: ZERO as VerifyResult['address'],
        addressTruncated: '0x0000…00000',
        humanHash: null,
        failures: ['attestation_not_found'],
        evidence: {
          checkedAt: nowRef.current.toISOString(),
          source: 'live',
          agentBook: { network: 'eip155:480', contract: CONTRACT as VerifyResult['address'] },
        },
      };
    }
    return resultFor(this.attestationMode);
  }
}

const ATTESTATION = { payload: { note: 'fake' }, signature: '0x00', signatureType: 'eip191' } as unknown as SignedAttestation;
const registry: Record<string, SignedAttestation> = { 'discord_application:app1': ATTESTATION };

const fake = new FakeVerifier();
const servers: Array<ReturnType<typeof createBadgeService>> = [];

async function start(overrides: Partial<BadgeServiceDeps> = {}): Promise<string> {
  const server = createBadgeService({
    verifier: fake,
    resolveAttestation: async (s) => registry[`${s.type}:${s.id}`] ?? null,
    publicBaseUrl: 'https://badge.example',
    now: () => nowRef.current,
    ...overrides,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  nowRef.current = new Date(T0);
  fake.calls = 0;
  fake.attestationMode = 'verified';
  fake.addressMode = 'verified';
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.toLowerCase().split(needle.toLowerCase()).length - 1;
}

function assertNoLeak(body: string, headers: Headers): void {
  expect(body).not.toContain(RAW_HUMAN);
  expect(body).not.toContain('"humanId"');
  // The full wallet address appears NOWHERE by default. The single
  // exception in the whole service is the /v1/status body for an
  // address subject, where the queried address appears exactly
  // once as the explicit subject echo (spec reconciliation); that
  // rule is asserted by assertAddressEchoOnce, not by stripping.
  expect(body.toLowerCase()).not.toContain(ADDR.toLowerCase());
  headers.forEach((value) => {
    expect(value).not.toContain(RAW_HUMAN);
    expect(value.toLowerCase()).not.toContain(ADDR.toLowerCase());
  });
}

/** The address-subject disclosure rule: exactly one occurrence of
 * the full address in the body (the subject echo); every other
 * field — evidence, results, badge URLs — truncated only. */
function assertAddressEchoOnce(body: string, headers: Headers): void {
  expect(body).not.toContain(RAW_HUMAN);
  expect(body).not.toContain('"humanId"');
  expect(countOccurrences(body, ADDR)).toBe(1);
  const parsed = JSON.parse(body) as { subject: { id: string }; badge: null };
  expect(parsed.subject.id).toBe(ADDR);
  expect(parsed.badge).toBeNull();
  headers.forEach((value) => {
    expect(value).not.toContain(RAW_HUMAN);
    expect(value.toLowerCase()).not.toContain(ADDR.toLowerCase());
  });
}

async function get(base: string, path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text();
  assertNoLeak(text, res.headers);
  return { res, text };
}

/** Raw HTTP request with full header control (fetch will not let a
 * test spoof Host, which the host-poisoning regression needs). */
function rawGet(
  base: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: u.hostname, port: u.port, path, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () =>
          resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function getPng(base: string, path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { headers });
  const buf = Buffer.from(await res.arrayBuffer());
  assertNoLeak(buf.toString('latin1'), res.headers);
  return { res, buf };
}

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function pixel(png: PNG, x: number, y: number): [number, number, number] {
  const idx = (y * png.width + x) * 4;
  return [png.data[idx]!, png.data[idx + 1]!, png.data[idx + 2]!];
}

const MATRIX: Array<{ mode: Mode; state: BadgeState; cacheControl: string }> = [
  { mode: 'verified', state: 'verified', cacheControl: 'public, max-age=300, s-maxage=300' },
  { mode: 'expired', state: 'expired', cacheControl: 'public, max-age=300, s-maxage=300' },
  { mode: 'unregistered', state: 'unverified', cacheControl: 'public, max-age=60, s-maxage=60' },
  { mode: 'invalid', state: 'unverified', cacheControl: 'public, max-age=60, s-maxage=60' },
  { mode: 'unknown', state: 'unverified', cacheControl: 'no-store' },
];

describe('badge routes: state x theme x format matrix', () => {
  it('keeps a passing Discord operator claim in neutral art until application control is proven', async () => {
    const base = await start();
    const image = await get(base, '/badge/discord_application/app1.svg?theme=dark');
    expect(image.text).toContain('Claim unconfirmed');
    expect(image.text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
    expect(image.text).not.toContain(`stroke="${PILL_PALETTES.dark.verified.ring}"`);
    const status = await get(base, '/v1/status/discord_application/app1');
    expect((JSON.parse(status.text) as { status: string }).status).toBe('verified');
  });

  for (const { mode, state, cacheControl } of MATRIX) {
    it(`${mode} renders the ${state} badge in both explicit themes, svg + png`, async () => {
      fake.addressMode = mode;
      const base = await start();
      for (const theme of ['dark', 'light'] as const) {
        const palette = PILL_PALETTES[theme][state];
        const svg = await get(base, `/badge/address/${ADDR}.svg?theme=${theme}`, {}, { addressSubject: true });
        expect(svg.res.status).toBe(200);
        expect(svg.res.headers.get('content-type')).toBe('image/svg+xml');
        expect(svg.res.headers.get('cache-control')).toBe(cacheControl);
        expect(svg.res.headers.get('x-checked-at')).toBe(T0.toISOString());
        expect(svg.res.headers.get('etag')).toBeTruthy();
        expect(svg.text).toContain(`fill="${palette.bg}"`);
        expect(svg.text).toContain(`stroke="${palette.ring}"`);
        expect(svg.text).toContain(`fill="${palette.dot}"`);
        expect(svg.text).toContain(palette.labelText);
        expect(svg.text).toContain('checked 14:03 UTC');
        expect(svg.text).toContain(`data-checked-at="${T0.toISOString()}"`);

        const png = await getPng(base, `/badge/address/${ADDR}.png?theme=${theme}`);
        expect(png.res.status).toBe(200);
        expect(png.res.headers.get('content-type')).toBe('image/png');
        expect(png.res.headers.get('cache-control')).toBe(cacheControl);
        expect(png.res.headers.get('x-badge-theme')).toBe(theme);
        const image = PNG.sync.read(png.buf);
        expect(image.height).toBe(84);
        expect(pixel(image, Math.floor(image.width / 2), 6)).toEqual(hexToRgb(palette.bg));
        expect(pixel(image, 45, 42)).toEqual(hexToRgb(palette.dot));
      }
    });

    it(`${mode} icon variant carries no timestamp text, in both themes`, async () => {
      fake.addressMode = mode;
      const base = await start();
      for (const theme of ['dark', 'light'] as const) {
        const svg = await get(base, `/badge/address/${ADDR}.svg?theme=${theme}&variant=icon`, {}, { addressSubject: true });
        expect(svg.text).toContain('width="64"');
        expect(svg.text).not.toContain('font-size="8.5"');
        const png = await getPng(base, `/badge/address/${ADDR}.png?theme=${theme}&variant=icon`);
        const image = PNG.sync.read(png.buf);
        expect(image.width).toBe(192);
        expect(image.height).toBe(192);
      }
    });
  }

  it('auto SVG embeds both palettes and the prefers-color-scheme block, no third palette', async () => {
    const base = await start();
    const svg = await get(base, `/badge/address/${ADDR}.svg?theme=auto`, {}, { addressSubject: true });
    expect(svg.text).toContain('@media (prefers-color-scheme: dark)');
    expect(svg.text).toContain(`.c-bg{fill:${PILL_PALETTES.light.verified.bg}}`);
    expect(svg.text).toContain(`.c-bg{fill:${PILL_PALETTES.dark.verified.bg}}`);
    expect(svg.text).toContain(`.c-ring{stroke:${PILL_PALETTES.light.verified.ring}}`);
    expect(svg.text).toContain(`.c-ring{stroke:${PILL_PALETTES.dark.verified.ring}}`);
    // Default (no theme param) is auto.
    const dflt = await get(base, `/badge/address/${ADDR}.svg`, {}, { addressSubject: true });
    expect(dflt.text).toContain('@media (prefers-color-scheme: dark)');
  });

  it('auto PNG resolves from the client hint, falls back to dark, reports X-Badge-Theme + Vary', async () => {
    const base = await start();
    const light = await getPng(base, `/badge/address/${ADDR}.png?theme=auto`, {
      'sec-ch-prefers-color-scheme': 'light',
    });
    expect(light.res.headers.get('x-badge-theme')).toBe('light');
    expect(light.res.headers.get('vary')).toBe('Sec-CH-Prefers-Color-Scheme');
    expect(pixel(PNG.sync.read(light.buf), 300, 6)).toEqual(hexToRgb(PILL_PALETTES.light.verified.bg));

    const dark = await getPng(base, `/badge/address/${ADDR}.png?theme=auto`, {
      'sec-ch-prefers-color-scheme': 'dark',
    });
    expect(dark.res.headers.get('x-badge-theme')).toBe('dark');
    expect(pixel(PNG.sync.read(dark.buf), 300, 6)).toEqual(hexToRgb(PILL_PALETTES.dark.verified.bg));

    const none = await getPng(base, `/badge/address/${ADDR}.png?theme=auto`);
    expect(none.res.headers.get('x-badge-theme')).toBe('dark');
    expect(pixel(PNG.sync.read(none.buf), 300, 6)).toEqual(hexToRgb(PILL_PALETTES.dark.verified.bg));
  });

  it('legacy alias /badge/<id>.svg resolves as discord_application', async () => {
    const base = await start();
    const svg = await get(base, '/badge/app1.svg?theme=dark');
    expect(svg.res.status).toBe(200);
    expect(svg.text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
    expect(svg.text).toContain('Claim unconfirmed');
  });
});

describe('JSON status route', () => {
  it('returns exactly the public shape plus subject, checkedAt, and the badge URL matrix', async () => {
    const base = await start();
    const { res, text } = await get(base, '/v1/status/discord_application/app1');
    expect(res.status).toBe(200);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'addressTruncated', 'badge', 'checkedAt', 'evidence', 'failures', 'humanHash', 'status', 'subject',
    ]);
    expect(body.status).toBe('verified');
    expect(body.addressTruncated).toBe(TRUNC);
    expect(body.humanHash).toBe(hashHumanId(RAW_HUMAN));
    expect(body.failures).toEqual([]);
    expect(body.checkedAt).toBe(T0.toISOString());
    expect(body.subject).toEqual({ type: 'discord_application', id: 'app1' });
    expect(body.badge).toEqual({
      svg: {
        auto: 'https://badge.example/badge/discord_application/app1.svg?theme=auto',
        dark: 'https://badge.example/badge/discord_application/app1.svg?theme=dark',
        light: 'https://badge.example/badge/discord_application/app1.svg?theme=light',
      },
      png: {
        auto: 'https://badge.example/badge/discord_application/app1.png?theme=auto',
        dark: 'https://badge.example/badge/discord_application/app1.png?theme=dark',
        light: 'https://badge.example/badge/discord_application/app1.png?theme=light',
      },
    });
  });

  it('resolver-null subject -> unknown + attestation_not_found, badge renders unverified', async () => {
    const base = await start();
    const { res, text } = await get(base, '/v1/status/discord_application/missing');
    expect(res.status).toBe(200);
    const body = JSON.parse(text) as { status: string; failures: string[]; humanHash: unknown };
    expect(body.status).toBe('unknown');
    expect(body.failures).toEqual(['attestation_not_found']);
    expect(body.humanHash).toBeNull();
    const svg = await get(base, '/badge/discord_application/missing.svg?theme=dark');
    expect(svg.text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
    expect(svg.res.headers.get('cache-control')).toBe('no-store');
  });

  it('address subjects verify through the core address path', async () => {
    const base = await start();
    const res = await fetch(`${base}/v1/status/address/${ADDR}`);
    const text = await res.text();
    // Spec reconciliation: the queried address appears exactly
    // once, as the subject echo; the response does not invent a
    // non-working truncated-address badge URL.
    assertAddressEchoOnce(text, res.headers);
    expect((JSON.parse(text) as { status: string }).status).toBe('verified');
    const svg = await get(base, `/badge/address/${ADDR}.svg?theme=light`);
    expect(svg.text).toContain(`stroke="${PILL_PALETTES.light.verified.ring}"`);
  });

  it('malformed address: 400 on JSON, unverified no-store badge on image routes, no core call', async () => {
    const base = await start();
    const before = fake.calls;
    const json = await get(base, '/v1/status/address/0xZZZ');
    expect(json.res.status).toBe(400);
    const svg = await get(base, '/badge/address/0xZZZ.svg?theme=dark');
    expect(svg.res.status).toBe(200);
    expect(svg.text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
    expect(svg.res.headers.get('cache-control')).toBe('no-store');
    expect(fake.calls).toBe(before);
  });

  it('unknown status returns 200 with status unknown on JSON (transport worked)', async () => {
    fake.attestationMode = 'unknown';
    const base = await start();
    const { res, text } = await get(base, '/v1/status/discord_application/app1');
    expect(res.status).toBe(200);
    expect((JSON.parse(text) as { status: string }).status).toBe('unknown');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('cache behaviour (SPEC 4.6 proposals)', () => {
  it('shares source resolution before verification for concurrent badge requests', async () => {
    let resolutions = 0;
    let activeResolutions = 0;
    let maxActiveResolutions = 0;
    const base = await start({
      resolveAttestation: async () => {
        resolutions++;
        activeResolutions++;
        maxActiveResolutions = Math.max(maxActiveResolutions, activeResolutions);
        await new Promise((resolve) => setTimeout(resolve, 500));
        activeResolutions--;
        return ATTESTATION;
      },
    });
    const paths = Array.from({ length: 30 }, () => `${base}/v1/status/discord_application/app1`);
    await Promise.all(paths.map((path) => fetch(path)));
    expect(resolutions).toBeLessThan(3);
    expect(maxActiveResolutions).toBe(1);
    expect(fake.calls).toBe(1);
  });

  it('bounds the combined registry and core wait with a no-store 503', async () => {
    const delayedVerifier: Verifier = {
      ...fake,
      resolveStatus: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return resultFor('verified');
      },
    };
    const base = await start({
      verifier: delayedVerifier,
      resolveAttestation: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return ATTESTATION;
      },
      requestTimeoutMs: 50,
    } as Partial<BadgeServiceDeps>);
    const response = await get(base, '/v1/status/discord_application/app1');
    expect(response.res.status).toBe(503);
    expect(response.text).toBe('{"error":"service busy"}');
    expect(response.res.headers.get('cache-control')).toBe('no-store');
    expect(response.res.headers.get('x-checked-at')).toBeNull();
  });

  it('renders a neutral no-store badge when source resolution exceeds the request deadline', async () => {
    const base = await start({
      resolveAttestation: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return ATTESTATION;
      },
      requestTimeoutMs: 30,
    });
    const image = await get(base, '/badge/discord_application/app1.svg?theme=dark');
    expect(image.res.status).toBe(200);
    expect(image.res.headers.get('cache-control')).toBe('no-store');
    expect(image.text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
    expect(image.text).not.toContain('Claim unconfirmed');
  });

  it('caps simultaneous source resolutions across distinct subjects', async () => {
    let active = 0;
    let peak = 0;
    const base = await start({
      maxConcurrentLookups: 3,
      resolveAttestation: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        return ATTESTATION;
      },
    });
    await Promise.all(Array.from({ length: 12 }, (_, id) =>
      get(base, `/v1/status/discord_application/app${id}`)));
    expect(peak).toBe(3);
  });

  it('drops queued source jobs after every caller times out', async () => {
    let sourceStarts = 0;
    let markStarted!: () => void;
    let releaseSource!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const sourceGate = new Promise<void>((resolve) => { releaseSource = resolve; });
    const base = await start({
      maxConcurrentLookups: 1,
      requestTimeoutMs: 150,
      resolveAttestation: async () => {
        sourceStarts++;
        if (sourceStarts === 1) {
          markStarted();
          await sourceGate;
        }
        return ATTESTATION;
      },
    });
    const requests = Promise.all(Array.from({ length: 3 }, (_, id) =>
      get(base, `/v1/status/discord_application/app${id}`)));
    await started;
    const responses = await requests;
    expect(responses.map(({ res }) => res.status)).toEqual([503, 503, 503]);
    expect(sourceStarts).toBe(1);
    releaseSource();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sourceStarts).toBe(1);
  });

  it('keeps a queued source job while a later shared caller is waiting', async () => {
    let applicationStarts = 0;
    let markBlockerStarted!: () => void;
    let releaseBlocker!: () => void;
    const blockerStarted = new Promise<void>((resolve) => { markBlockerStarted = resolve; });
    const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const base = await start({
      maxConcurrentLookups: 1,
      requestTimeoutMs: 1000,
      resolveAttestation: async (subject) => {
        if (subject.id === 'blocker') {
          markBlockerStarted();
          await blockerGate;
        } else {
          applicationStarts++;
        }
        return ATTESTATION;
      },
    });
    const blocker = get(base, '/v1/status/discord_application/blocker');
    await blockerStarted;
    const first = get(base, '/v1/status/discord_application/app1');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const second = get(base, '/v1/status/discord_application/app1');
    let timedOut;
    try {
      timedOut = await first;
    } finally {
      releaseBlocker();
    }
    const surviving = await second;
    await blocker;
    expect(timedOut.res.status).toBe(503);
    expect((JSON.parse(surviving.text) as { status: string }).status).toBe('verified');
    expect(applicationStarts).toBe(1);
  });

  it('lets a later caller complete a shared check after an earlier caller times out', async () => {
    let notifyStarted!: () => void;
    let finishCore!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const coreGate = new Promise<void>((resolve) => { finishCore = resolve; });
    const delayedVerifier: Verifier = {
      ...fake,
      resolveStatus: async () => {
        notifyStarted();
        await coreGate;
        return resultFor('verified');
      },
    };
    const base = await start({ verifier: delayedVerifier, requestTimeoutMs: 250 });
    const first = get(base, '/v1/status/discord_application/app1');
    await started;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = get(base, '/v1/status/discord_application/app1');
    const early = await first;
    finishCore();
    const later = await second;
    expect(early.res.status).toBe(503);
    expect((JSON.parse(later.text) as { status: string }).status).toBe('verified');
  });

  it('reports a registry failure as unknown without claiming AgentBook is down', async () => {
    const base = await start({
      verifier: createVerifier({ reader: { lookupHuman: async () => null } }),
      resolveAttestation: async () => { throw new Error('registry offline'); },
    });
    const status = await get(base, '/v1/status/discord_application/app1');
    expect((JSON.parse(status.text) as { status: string; failures: string[] }).status).toBe('unknown');
    expect(status.res.headers.get('cache-control')).toBe('no-store');
    const health = await get(base, '/health');
    expect((JSON.parse(health.text) as { agentBookReachable: boolean }).agentBookReachable).toBe(true);
  });

  it('drops a cached verification when a registry entry disappears', async () => {
    let current: SignedAttestation | null = ATTESTATION;
    const base = await start({ resolveAttestation: async () => current });
    const first = await get(base, '/v1/status/discord_application/app1');
    expect((JSON.parse(first.text) as { status: string }).status).toBe('verified');
    current = null;
    const removed = await get(base, '/v1/status/discord_application/app1');
    expect((JSON.parse(removed.text) as { status: string }).status).toBe('unknown');
    expect(removed.res.headers.get('cache-control')).toBe('no-store');
    expect(fake.calls).toBe(2);
  });

  it('rechecks when a registry attestation changes at the same URL', async () => {
    let current: SignedAttestation = ATTESTATION;
    const base = await start({ resolveAttestation: async () => current });
    await get(base, '/v1/status/discord_application/app1');
    current = { ...ATTESTATION, signature: '0x01' };
    await get(base, '/v1/status/discord_application/app1');
    expect(fake.calls).toBe(2);
  });

  it('reduces downstream max-age by time already spent in the server cache', async () => {
    const base = await start();
    await get(base, `/badge/address/${ADDR}.svg?theme=dark`, {}, { addressSubject: true });
    nowRef.current = new Date(T0.getTime() + 200_000);
    const cached = await get(base, `/badge/address/${ADDR}.svg?theme=dark`, {}, { addressSubject: true });
    expect(cached.res.headers.get('cache-control')).toContain('max-age=100');
    expect(cached.res.headers.get('cache-control')).not.toContain('stale-while-revalidate');
    expect(fake.calls).toBe(1);
  });

  it('verified result serves from cache inside 300s with the original check time, rechecks after', async () => {
    const base = await start();
    const first = await get(base, '/badge/discord_application/app1.svg?theme=dark');
    const second = await get(base, '/badge/discord_application/app1.svg?theme=dark');
    expect(fake.calls).toBe(1);
    expect(second.res.headers.get('x-checked-at')).toBe(first.res.headers.get('x-checked-at'));
    expect(second.text).toContain('checked 14:03 UTC');
    nowRef.current = new Date(T0.getTime() + 300_000);
    await get(base, '/badge/discord_application/app1.svg?theme=dark');
    expect(fake.calls).toBe(2);
  });

  it('stale-on-error: failed refresh inside 900s serves cached verified as cache; past 900s is unknown', async () => {
    const base = await start();
    await get(base, '/v1/status/discord_application/app1');
    expect(fake.calls).toBe(1);
    fake.attestationMode = 'unknown';
    nowRef.current = new Date(T0.getTime() + 400_000);
    const stale = await get(base, '/v1/status/discord_application/app1');
    const staleBody = JSON.parse(stale.text) as { status: string; checkedAt: string; evidence: { source: string } };
    expect(staleBody.status).toBe('verified');
    expect(staleBody.checkedAt).toBe(T0.toISOString());
    expect(staleBody.evidence.source).toBe('cache');
    nowRef.current = new Date(T0.getTime() + 901_000);
    const fresh = await get(base, '/v1/status/discord_application/app1');
    expect((JSON.parse(fresh.text) as { status: string }).status).toBe('unknown');
    const svg = await get(base, '/badge/discord_application/app1.svg?theme=dark');
    expect(svg.text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
  });

  it('negative results recheck after 60s (the just-registered turnaround)', async () => {
    fake.attestationMode = 'unregistered';
    const base = await start();
    await get(base, '/v1/status/discord_application/app1');
    nowRef.current = new Date(T0.getTime() + 30_000);
    const cached = await get(base, '/v1/status/discord_application/app1');
    expect((JSON.parse(cached.text) as { status: string }).status).toBe('unregistered');
    expect(fake.calls).toBe(1);
    fake.attestationMode = 'verified';
    nowRef.current = new Date(T0.getTime() + 61_000);
    const turned = await get(base, '/v1/status/discord_application/app1');
    expect((JSON.parse(turned.text) as { status: string }).status).toBe('verified');
    expect(fake.calls).toBe(2);
  });
});

describe('failure behaviour, abuse posture, and misc routes', () => {
  it('rate limit: 429 on JSON; badge routes shed load without rasterising', async () => {
    const base = await start({ rateLimitMax: 3 });
    for (let i = 0; i < 3; i++) await get(base, '/v1/status/discord_application/app1');
    const limited = await get(base, '/v1/status/discord_application/app1');
    expect(limited.res.status).toBe(429);
    // A 429 claims no check ran: no check-time header, ever.
    expect(limited.res.headers.get('x-checked-at')).toBeNull();

    // Fix-pass behaviour (supersedes the original grey-on-limit
    // expectation): a limited badge request serves the subject's
    // last render when one exists — the same bytes, no-store, and
    // crucially no fresh render — instead of rasterising a grey
    // badge under load.
    let renders = 0;
    const badgeBase = await start({ rateLimitMax: 1, onRender: () => renders++ });
    const first = await get(badgeBase, '/badge/discord_application/app1.svg?theme=dark');
    expect(first.text).toContain('Claim unconfirmed');
    expect(first.text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
    expect(renders).toBe(1);
    const limitedBadge = await get(badgeBase, '/badge/discord_application/app1.svg?theme=dark');
    expect(limitedBadge.res.status).toBe(200);
    expect(limitedBadge.text).toBe(first.text);
    expect(limitedBadge.res.headers.get('cache-control')).toBe('no-store');
    expect(renders).toBe(1);
  });

  it('rate-limited badge with nothing rendered yet: unchecked badge, no fabricated check time', async () => {
    const base = await start({ rateLimitMax: 0 });
    const { res, text } = await get(base, '/badge/discord_application/app1.svg?theme=dark');
    expect(res.status).toBe(200);
    expect(text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-checked-at')).toBeNull();
    expect(text).not.toContain('checked ');
    expect(text).not.toContain('data-checked-at');
  });

  it('stops reusing a verified badge after its original check expires under sustained rate limiting', async () => {
    const base = await start({ rateLimitMax: 1, rateLimitWindowMs: 1_000_000 });
    const path = `/badge/address/${ADDR}.svg?theme=dark`;
    const first = await get(base, path, {}, { addressSubject: true });
    expect(first.text).toContain(`stroke="${PILL_PALETTES.dark.verified.ring}"`);

    nowRef.current = new Date(T0.getTime() + 299_000);
    const stillFresh = await get(base, path, {}, { addressSubject: true });
    expect(stillFresh.text).toBe(first.text);
    expect(stillFresh.res.headers.get('cache-control')).toBe('no-store');

    nowRef.current = new Date(T0.getTime() + 301_000);
    const expired = await get(base, path, {}, { addressSubject: true });
    expect(expired.text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
    expect(expired.text).not.toContain(`stroke="${PILL_PALETTES.dark.verified.ring}"`);
    expect(expired.text).not.toContain('data-checked-at');
    expect(expired.res.headers.get('x-checked-at')).toBeNull();
    expect(fake.calls).toBe(1);
  });

  it('keeps rate-limit PNG fallbacks separate by theme and variant', async () => {
    const base = await start({ rateLimitMax: 0 });
    const lightIcon = await getPng(base, '/badge/discord_application/app1.png?theme=light&variant=icon');
    const darkPill = await getPng(base, '/badge/discord_application/app1.png?theme=dark&variant=pill');
    const autoLight = await getPng(base, '/badge/discord_application/app1.png?theme=auto&variant=pill', {
      'sec-ch-prefers-color-scheme': 'light',
    });
    const icon = PNG.sync.read(lightIcon.buf);
    const pill = PNG.sync.read(darkPill.buf);
    const autoPill = PNG.sync.read(autoLight.buf);
    expect(icon.width).toBe(192);
    expect(pill.width).toBeGreaterThan(192);
    expect(autoPill.width).toBe(pill.width);
    expect(lightIcon.res.headers.get('x-badge-theme')).toBe('light');
    expect(darkPill.res.headers.get('x-badge-theme')).toBe('dark');
    expect(autoLight.res.headers.get('x-badge-theme')).toBe('light');
    expect(darkPill.res.headers.get('cache-control')).toBe('no-store');
    expect(autoLight.res.headers.get('vary')).toBe('Sec-CH-Prefers-Color-Scheme');
    expect(pixel(pill, Math.floor(pill.width / 2), 6)).toEqual(hexToRgb(PILL_PALETTES.dark.unverified.bg));
    expect(pixel(autoPill, Math.floor(autoPill.width / 2), 6)).toEqual(hexToRgb(PILL_PALETTES.light.unverified.bg));
    expect(lightIcon.buf.equals(darkPill.buf)).toBe(false);
    expect(fake.calls).toBe(0);
  });

  it('no fetch route exists; a ?url= parameter fetches nothing', async () => {
    const base = await start();
    const res = await fetch(`${base}/v1/fetch?url=https://example.com/x.json`);
    expect(res.status).toBe(404);
    assertNoLeak(await res.text(), res.headers);
    const before = fake.calls;
    const svg = await get(base, '/badge/discord_application/app1.svg?theme=dark&url=https://example.com/x.json');
    expect(svg.res.status).toBe(200);
    expect(fake.calls).toBe(before + 1); // the normal core check, and nothing else
  });

  it('/health flips agentBookReachable on lookup failure and carries no subject data', async () => {
    const base = await start();
    const ok = await get(base, '/health');
    const okBody = JSON.parse(ok.text) as Record<string, unknown>;
    expect(Object.keys(okBody).sort()).toEqual(['agentBookReachable', 'lastLookupMs', 'ok']);
    expect(okBody.ok).toBe(true);
    expect(okBody.agentBookReachable).toBe(true);
    expect(okBody.lastLookupMs).toBeNull();
    fake.attestationMode = 'unknown';
    await get(base, '/v1/status/discord_application/app1');
    const down = await get(base, '/health');
    expect((JSON.parse(down.text) as { agentBookReachable: boolean }).agentBookReachable).toBe(false);
  });

  it('explainer page ships both themes, persists the toggle, and shows live examples', async () => {
    const base = await start();
    const { res, text } = await get(base, '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(text).toContain('@media (prefers-color-scheme: dark)');
    expect(text).toContain('localStorage');
    expect(text).toContain('data-theme');
    expect(text).toContain('/badge/discord_application/example.svg?theme=dark');
    expect(text).toContain('/badge/discord_application/example.svg?theme=light');
    expect(text).toContain('/badge/discord_application/example.svg?theme=auto');
    expect(text.toLowerCase()).not.toContain('identity verified');
    expect(text).toContain('Grey does not\nalways mean a claim failed');
    expect(text).toContain('A valid operator claim stays grey on a\nDiscord application badge');
  });

  it('smoke: every route answers on one booted server', async () => {
    const base = await start();
    for (const path of [
      '/',
      '/health',
      '/v1/status/discord_application/app1',
      '/badge/discord_application/app1.svg?theme=auto',
      '/badge/discord_application/app1.png?theme=auto',
      '/badge/discord_application/app1.svg?theme=light&variant=icon',
    ]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      assertNoLeak(await res.text(), res.headers);
    }
  });
});

describe('check-time label (SPEC 4.4)', () => {
  it('bare time today, date plus time when not today', () => {
    expect(formatCheckedLabel('2026-10-26T14:03:00.000Z', new Date('2026-10-26T23:59:00Z'))).toBe('checked 14:03 UTC');
    expect(formatCheckedLabel('2026-10-25T14:03:00.000Z', new Date('2026-10-26T00:01:00Z'))).toBe(
      'checked 2026-10-25 14:03 UTC',
    );
  });
});

// ---------------------------------------------------------------------------
// Review fix pass (PR #30 adversarial review: NOT SHIPPABLE -> fixes)
// ---------------------------------------------------------------------------

describe('fix pass: composite subject keys (blocker)', () => {
  // The exact probed pair: under `${type}:${id}` keying these are
  // the SAME string ("discord_application:x:y"); they are distinct
  // subjects and must never share a cache entry, a registry entry,
  // or a badge.
  const attA = { payload: { note: 'A' }, signature: '0x00', signatureType: 'eip191' } as unknown as SignedAttestation;
  const attB = { payload: { note: 'B' }, signature: '0x00', signatureType: 'eip191' } as unknown as SignedAttestation;

  class PairVerifier extends FakeVerifier {
    override async resolveStatus(subject: Parameters<Verifier['resolveStatus']>[0]): Promise<VerifyResult> {
      if (subject.kind !== 'attested_subject') return super.resolveStatus(subject);
      const att = await subject.resolveAttestation(subject.subject);
      if (!att) {
        return {
          status: 'unknown',
          address: ZERO as VerifyResult['address'],
          addressTruncated: '0x0000…00000',
          humanHash: null,
          failures: ['attestation_not_found'],
          evidence: {
            checkedAt: nowRef.current.toISOString(),
            source: 'live',
            agentBook: { network: 'eip155:480', contract: CONTRACT as VerifyResult['address'] },
          },
        };
      }
      const note = (att as unknown as { payload: { note: string } }).payload.note;
      if (note === 'B') {
        return { ...resultFor('expired'), humanHash: hashHumanId(`0x${'b2'.repeat(32)}`) };
      }
      return resultFor('verified');
    }
  }

  it('(discord_application, "x:y") and (discord_application:x, "y") return independent results and badges', async () => {
    const pairFake = new PairVerifier();
    const pairRegistry = new Map<string, SignedAttestation>([
      [JSON.stringify(['discord_application', 'x:y']), attA],
      [JSON.stringify(['discord_application:x', 'y']), attB],
    ]);
    const base = await start({
      verifier: pairFake,
      resolveAttestation: async (s) => pairRegistry.get(JSON.stringify([s.type, s.id])) ?? null,
    });
    const a = await get(base, '/v1/status/discord_application/x%3Ay');
    const aBody = JSON.parse(a.text) as { status: string; humanHash: string };
    expect(aBody.status).toBe('verified');
    expect(aBody.humanHash).toBe(hashHumanId(RAW_HUMAN));

    const b = await get(base, '/v1/status/discord_application%3Ax/y');
    const bBody = JSON.parse(b.text) as { status: string; humanHash: string };
    expect(bBody.status).toBe('expired');
    expect(bBody.humanHash).toBe(hashHumanId(`0x${'b2'.repeat(32)}`));
    expect(b.res.headers.get('etag')).not.toBe(a.res.headers.get('etag'));

    // B's badge is B's state (expired), not A's cached verified.
    const aBadge = await get(base, '/badge/discord_application/x%3Ay.svg?theme=dark');
    expect(aBadge.text).toContain('Claim unconfirmed');
    expect(aBadge.text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
    const bBadge = await get(base, '/badge/discord_application%3Ax/y.svg?theme=dark');
    expect(bBadge.text).toContain(`stroke="${PILL_PALETTES.dark.expired.ring}"`);
    expect(bBadge.text).not.toContain(PILL_PALETTES.dark.verified.ring);
  });

  it('registry keys are the JSON pair encoding end-to-end (FileRegistry)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'badge-reg-'));
    const file = join(dir, 'registry.json');
    writeFileSync(
      file,
      JSON.stringify({
        discord_application: { 'x:y': JSON.parse(JSON.stringify(attA)) },
        'discord_application:x': { y: JSON.parse(JSON.stringify(attB)) },
      }),
    );
    const deps = depsFromEnv({ VERIFY_REGISTRY_FILE: file });
    const a = await deps.resolveAttestation!({ type: 'discord_application', id: 'x:y' });
    const b = await deps.resolveAttestation!({ type: 'discord_application:x', id: 'y' });
    expect((a as unknown as { payload: { note: string } }).payload.note).toBe('A');
    expect((b as unknown as { payload: { note: string } }).payload.note).toBe('B');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('fix pass: host poisoning', () => {
  it('badge URLs come only from the configured base; a poisoned Host changes nothing', async () => {
    // No publicBaseUrl configured -> path-relative URLs, no host.
    const base = await start({ publicBaseUrl: undefined });
    const normal = await rawGet(base, '/v1/status/discord_application/app1');
    const poisoned = await rawGet(base, '/v1/status/discord_application/app1', {
      host: 'evil.example',
      'x-forwarded-proto': 'https',
    });
    expect(poisoned.status).toBe(200);
    expect(poisoned.text).not.toContain('evil.example');
    const body = JSON.parse(poisoned.text) as { badge: { svg: Record<string, string> } };
    for (const url of Object.values(body.badge.svg)) {
      expect(url.startsWith('/badge/')).toBe(true);
    }
    // Same ETag semantics regardless of the request's Host: the
    // ETag is base-blind only in that the base is config, never
    // request-derived, so a shared cache cannot be poisoned.
    expect(poisoned.headers.etag).toBe(normal.headers.etag);
    // Discord application claims are never cached publicly without
    // a separate application-control check.
    expect(poisoned.headers['cache-control']).toBe('no-store');
  });

  it('with a configured base, a poisoned Host still yields the configured base', async () => {
    const base = await start(); // publicBaseUrl: https://badge.example
    const poisoned = await rawGet(base, '/v1/status/discord_application/app1', { host: 'evil.example' });
    expect(poisoned.text).not.toContain('evil.example');
    expect(poisoned.text).toContain('https://badge.example/badge/');
  });
});

describe('fix pass: render cost is shed', () => {
  it('repeated + conditional PNG requests render at most once per unique badge state', async () => {
    let renders = 0;
    const base = await start({ onRender: () => renders++ });
    const first = await fetch(`${base}/badge/discord_application/app1.png?theme=dark`);
    const firstBuf = Buffer.from(await first.arrayBuffer());
    expect(first.status).toBe(200);
    expect(renders).toBe(1);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const second = await fetch(`${base}/badge/discord_application/app1.png?theme=dark`);
    expect(Buffer.from(await second.arrayBuffer()).equals(firstBuf)).toBe(true);
    expect(renders).toBe(1); // render cache hit: no rasterisation

    const conditional = await fetch(`${base}/badge/discord_application/app1.png?theme=dark`, {
      headers: { 'if-none-match': etag! },
    });
    expect(conditional.status).toBe(304);
    expect(renders).toBe(1); // 304 answered from the ETag, before any render

    // A different theme is a different render (exactly once more).
    const otherTheme = await fetch(`${base}/badge/discord_application/app1.png?theme=light`);
    expect(otherTheme.status).toBe(200);
    await otherTheme.arrayBuffer();
    expect(renders).toBe(2);
  });

  it('SVG honours If-None-Match with 304 and does not re-render', async () => {
    let renders = 0;
    const base = await start({ onRender: () => renders++ });
    const first = await get(base, '/badge/discord_application/app1.svg?theme=dark');
    expect(renders).toBe(1);
    const conditional = await fetch(`${base}/badge/discord_application/app1.svg?theme=dark`, {
      headers: { 'if-none-match': first.res.headers.get('etag')! },
    });
    expect(conditional.status).toBe(304);
    expect(renders).toBe(1);
  });

  it('JSON route honours If-None-Match with 304', async () => {
    const base = await start();
    const first = await get(base, '/v1/status/discord_application/app1');
    const conditional = await fetch(`${base}/v1/status/discord_application/app1`, {
      headers: { 'if-none-match': first.res.headers.get('etag')! },
    });
    expect(conditional.status).toBe(304);
  });
});

describe('fix pass: bounded result cache', () => {
  it('5000 unique subjects leave retained entries at the default cap (1000)', async () => {
    fake.addressMode = 'unregistered';
    const server = createBadgeService({
      verifier: fake,
      publicBaseUrl: 'https://badge.example',
      now: () => nowRef.current,
      rateLimitMax: 100_000, // the cap under test is the cache's, not the limiter's
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${addr.port}`;
    const addrFor = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
    for (let batch = 0; batch < 5000; batch += 200) {
      await Promise.all(
        Array.from({ length: 200 }, async (_, k) => {
          const res = await fetch(`${base}/v1/status/address/${addrFor(batch + k)}`);
          await res.text();
          expect(res.status).toBe(200);
        }),
      );
    }
    expect(server.badgeInternals.resultCacheSize()).toBe(1000);
  }, 60_000);

  it('eviction is LRU: the oldest subject is rechecked, the newest is not', async () => {
    fake.addressMode = 'unregistered';
    const base = await start({ cacheMaxEntries: 3 });
    const addrFor = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
    for (let i = 1; i <= 4; i++) await get(base, `/v1/status/address/${addrFor(i)}`);
    expect(fake.calls).toBe(4);
    await get(base, `/v1/status/address/${addrFor(4)}`); // newest: cached
    expect(fake.calls).toBe(4);
    await get(base, `/v1/status/address/${addrFor(1)}`); // evicted: rechecked
    expect(fake.calls).toBe(5);
  });
});

describe('fix pass: registry refresh and validation (SPEC 4.6)', () => {
  const attestationDoc = (note: string) => ({
    discord_application: {
      app1: { payload: { note }, signature: '0x00', signatureType: 'eip191' },
    },
  });

  it('keeps an unchanged, validated file fresh across 24 hours and expires after failed reloads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'badge-reg-'));
    const file = join(dir, 'registry.json');
    writeFileSync(file, JSON.stringify(attestationDoc('one')));
    let clockMs = T0.getTime();
    const source = new FileRegistry(file, 'VERIFY_REGISTRY_FILE', {
      now: () => clockMs,
      refreshMs: 300_000,
      log: () => {},
    });
    const subject = { type: 'discord_application', id: 'app1' };
    try {
      source.loadInitial();
      expect(await source.resolve(subject)).not.toBeNull();

      // Unchanged mtime and size must not make a healthy source age out.
      clockMs += 300_000;
      source.refreshIfDue(clockMs);
      clockMs = T0.getTime() + 86_400_001;
      source.refreshIfDue(clockMs);
      expect(await source.resolve(subject)).not.toBeNull();

      // A real failed reload still ages out the last good registry.
      writeFileSync(file, '{corrupt');
      clockMs += 300_000;
      source.refreshIfDue(clockMs);
      expect(await source.resolve(subject)).not.toBeNull();
      clockMs += 86_400_001;
      source.refreshIfDue(clockMs);
      expect(await source.resolve(subject)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts and validates the canonical entries[] file at startup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'badge-reg-'));
    const file = join(dir, 'registry.json');
    writeFileSync(file, JSON.stringify({ version: 1, entries: [] }));
    const deps = depsFromEnv({ VERIFY_REGISTRY_FILE: file });
    expect(deps.sourceVersion).toBeTypeOf('function');
    expect(await deps.resolveAttestation?.({ type: 'discord_application', id: '123456789012345678' })).toBeNull();
    expect(depsFromEnv({ VERIFY_REGISTRY_URL: 'https://registry.example/registry.json' }).sourceVersion).toBeTypeOf('function');
    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ discord_application_id: 'bad', attestation_url: 'http://example.com/a' }] }));
    expect(() => depsFromEnv({ VERIFY_REGISTRY_FILE: file })).toThrow(ConfigError);
    rmSync(dir, { recursive: true, force: true });
  });

  it('production depsFromEnv wiring refreshes: removing an attestation takes effect without restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'badge-reg-'));
    const file = join(dir, 'registry.json');
    writeFileSync(file, JSON.stringify(attestationDoc('one')));
    const deps = depsFromEnv({ VERIFY_REGISTRY_FILE: file, REGISTRY_REFRESH_MS: '40' });
    const server = createBadgeService({ ...deps });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${addr.port}`;

    // Attestation present: the real core runs it and finds it
    // invalid (fixture signature) — the point is it was FOUND.
    const found = await fetch(`${base}/v1/status/discord_application/app1`);
    const foundBody = (await found.json()) as { failures: string[] };
    expect(foundBody.failures).not.toContain('attestation_not_found');

    // Remove the attestation; after the refresh cadence the same
    // request resolves as not found, with no restart.
    writeFileSync(file, JSON.stringify({ discord_application: {} }));
    await new Promise((r) => setTimeout(r, 90));
    const gone = await fetch(`${base}/v1/status/discord_application/app1`);
    const goneBody = (await gone.json()) as { status: string; failures: string[] };
    expect(goneBody.status).toBe('unknown');
    expect(goneBody.failures).toContain('attestation_not_found');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a failed reload keeps the last good registry and the service keeps serving', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'badge-reg-'));
    const file = join(dir, 'registry.json');
    writeFileSync(file, JSON.stringify(attestationDoc('one')));
    const deps = depsFromEnv({ VERIFY_REGISTRY_FILE: file, REGISTRY_REFRESH_MS: '40' });
    const server = createBadgeService({ ...deps });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${addr.port}`;
    const before = await fetch(`${base}/v1/status/discord_application/app1`);
    expect(before.status).toBe(200);
    writeFileSync(file, '{corrupt');
    await new Promise((r) => setTimeout(r, 90));
    const after = await fetch(`${base}/v1/status/discord_application/app1`);
    expect(after.status).toBe(200);
    const body = (await after.json()) as { failures: string[] };
    expect(body.failures).not.toContain('attestation_not_found'); // last good registry still serving
    rmSync(dir, { recursive: true, force: true });
  });

  it('null/scalar/array registries and non-attestation values are sanitised startup errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'badge-reg-'));
    const file = join(dir, 'registry.json');
    for (const doc of ['null', '"scalar"', '[1,2]', '{"t":"scalar"}', '{"t":{"i":42}}', '{"t":{"i":{"payload":{}}}}']) {
      writeFileSync(file, doc);
      expect(() => depsFromEnv({ VERIFY_REGISTRY_FILE: file }), doc).toThrow(ConfigError);
      expect(() => depsFromEnv({ VERIFY_REGISTRY_FILE: file }), doc).toThrow(/VERIFY_REGISTRY_FILE/);
    }
    // Malformed JSON: the error names the variable and the problem
    // class, and contains nothing of the file's content.
    writeFileSync(file, '{"marker": "LEAKMARKER-7f3d"');
    try {
      depsFromEnv({ VERIFY_REGISTRY_FILE: file });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('VERIFY_REGISTRY_FILE');
      expect((err as Error).message).not.toContain('LEAKMARKER-7f3d');
    }
    // Missing file: a clean startup error, not a stack.
    expect(() => depsFromEnv({ VERIFY_REGISTRY_FILE: join(dir, 'absent.json') })).toThrow(/could not be read/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('registry file size is bounded at load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'badge-reg-'));
    const file = join(dir, 'registry.json');
    writeFileSync(file, JSON.stringify(attestationDoc('x')).padEnd(4096, ' '));
    expect(() => depsFromEnv({ VERIFY_REGISTRY_FILE: file, REGISTRY_MAX_BYTES: '1024' })).toThrow(/size limit/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('fix pass: configuration strictness and bind posture', () => {
  it('zero/negative/garbage numeric config is a startup error naming the variable', () => {
    for (const env of [
      { RATE_LIMIT_MAX: '0' },
      { RATE_LIMIT_MAX: 'abc' },
      { RATE_LIMIT_WINDOW_MS: '-1' },
      { CACHE_TTL_VERIFIED_MS: '0' },
      { CACHE_TTL_NEGATIVE_MS: '1.5' },
      { STALE_ON_ERROR_MS: '-900' },
      { VERIFY_TIMEOUT_MS: '50' },
      { VERIFY_TIMEOUT_MS: '99999999' },
      { CACHE_MAX_ENTRIES: '0' },
      { LOOKUP_QUEUE_MAX: '-2' },
      { REGISTRY_REFRESH_MS: 'abc' },
      { REGISTRY_REFRESH_MS: '0' },
      { REGISTRY_MAX_BYTES: '10' },
      { REGISTRY_MAX_BYTES: '-1' },
    ]) {
      const name = Object.keys(env)[0]!;
      expect(() => depsFromEnv(env), JSON.stringify(env)).toThrow(new RegExp(name));
    }
    expect(() => portFromEnv({ PORT: '0' })).toThrow(/PORT/);
    expect(() => portFromEnv({ PORT: 'notaport' })).toThrow(/PORT/);
    expect(portFromEnv({})).toBe(8788);
  });

  it('bind defaults to loopback, BADGE_HOST overrides', () => {
    expect(hostFromEnv({})).toBe('127.0.0.1');
    expect(hostFromEnv({ BADGE_HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });

  it('rejects a public badge base with a query, fragment, or credentials', () => {
    for (const base of ['https://badge.example/path?campaign=1', 'https://badge.example/path#anchor', 'https://user:pass@badge.example/path']) {
      expect(() => depsFromEnv({ BADGE_PUBLIC_BASE_URL: base })).toThrow(ConfigError);
      expect(() => depsFromEnv({ BADGE_PUBLIC_BASE_URL: base })).toThrow(/BADGE_PUBLIC_BASE_URL/);
    }
    expect(depsFromEnv({ BADGE_PUBLIC_BASE_URL: 'https://badge.example/path/' }).publicBaseUrl)
      .toBe('https://badge.example/path/');
  });
});

describe('fix pass: lookup queue bounds and the core signal', () => {
  it('a saturated lookup queue rejects with 503 on JSON and a grey badge; the core receives an AbortSignal', async () => {
    const seenSignals: Array<AbortSignal | undefined> = [];
    const hanging: Verifier = {
      async verifyAddress() {
        throw new Error('unused');
      },
      async verifyAttestation() {
        throw new Error('unused');
      },
      async resolveStatus(_s, opts) {
        seenSignals.push(opts?.signal);
        await new Promise((r) => setTimeout(r, 400));
        return resultFor('verified');
      },
    };
    const base = await start({
      verifier: hanging,
      maxConcurrentLookups: 1,
      lookupQueueMax: 0,
      lookupDeadlineMs: 5_000,
    });
    const first = fetch(`${base}/v1/status/discord_application/slow1`);
    await new Promise((r) => setTimeout(r, 30)); // first lookup occupies the only slot
    const second = await fetch(`${base}/v1/status/discord_application/slow2`);
    expect(second.status).toBe(503);
    expect(second.headers.get('cache-control')).toBe('no-store');
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    await firstRes.text();
    expect(seenSignals.length).toBeGreaterThan(0);
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('fix pass: malformed encodings and route semantics', () => {
  it('malformed percent-encoding: 400 on JSON, grey no-store badge on badge routes, never 500', async () => {
    const base = await start();
    const json = await rawGet(base, '/v1/status/discord_application/%E0%A4%A');
    expect(json.status).toBe(400);
    const badge = await rawGet(base, '/badge/discord_application/%E0%A4%A.svg');
    expect(badge.status).toBe(200);
    expect(badge.text).toContain(PILL_PALETTES.dark.unverified.ring);
    expect(badge.headers['cache-control']).toBe('no-store');
    expect(badge.headers['x-checked-at']).toBeUndefined();
  });

  it('HEAD answers with headers and no body; other methods are 405, not 404', async () => {
    const base = await start();
    const headBadge = await fetch(`${base}/badge/discord_application/app1.svg?theme=dark`, { method: 'HEAD' });
    expect(headBadge.status).toBe(200);
    expect(headBadge.headers.get('etag')).toBeTruthy();
    expect(await headBadge.text()).toBe('');
    const headJson = await fetch(`${base}/v1/status/discord_application/app1`, { method: 'HEAD' });
    expect(headJson.status).toBe(200);
    expect(await headJson.text()).toBe('');
    const post = await fetch(`${base}/v1/status/discord_application/app1`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toContain('GET');
    const put = await fetch(`${base}/badge/discord_application/app1.svg`, { method: 'PUT' });
    expect(put.status).toBe(405);
  });

  it('invalid theme/variant values are 400, not silent coercion', async () => {
    const base = await start();
    expect((await get(base, '/badge/discord_application/app1.svg?theme=neon')).res.status).toBe(400);
    expect((await get(base, '/badge/discord_application/app1.svg?variant=wide')).res.status).toBe(400);
    expect((await get(base, '/badge/discord_application/app1.svg?theme=dark&variant=pill')).res.status).toBe(200);
  });

  it('route near-misses get grey-badge / 400 semantics', async () => {
    const base = await start();
    const emptyId = await get(base, '/badge/discord_application/.svg?theme=dark');
    expect(emptyId.res.status).toBe(200);
    expect(emptyId.text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
    expect(emptyId.res.headers.get('cache-control')).toBe('no-store');
    const upper = await get(base, '/badge/discord_application/app1.SVG?theme=dark');
    expect(upper.res.status).toBe(200);
    expect(upper.text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`); // near-miss: grey, not the real badge
    const slash = await get(base, '/badge/discord_application/app1.svg/?theme=dark');
    expect(slash.res.status).toBe(200);
    expect(slash.text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
    expect((await get(base, '/v1/status/discord_application/app1/')).res.status).toBe(400);
    expect((await get(base, '/v1/status/discord_application/')).res.status).toBe(400);
  });

  it("subjectType 'address' matching is normalised: Address/notanaddress is a 400, not a 200 unknown", async () => {
    const base = await start();
    expect((await get(base, '/v1/status/Address/notanaddress')).res.status).toBe(400);
    const upperRes = await fetch(`${base}/v1/status/ADDRESS/${ADDR}`);
    const upperText = await upperRes.text();
    expect(upperRes.status).toBe(200);
    assertAddressEchoOnce(upperText, upperRes.headers);
    const grey = await get(base, '/badge/Address/notanaddress.svg?theme=dark');
    expect(grey.text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
  });

  it('subject length caps align with the core (type <= 64, id <= 256): 400 / grey on breach', async () => {
    const base = await start();
    const longType = 't'.repeat(65);
    const longId = 'i'.repeat(257);
    expect((await get(base, `/v1/status/${longType}/app1`)).res.status).toBe(400);
    expect((await get(base, `/v1/status/discord_application/${longId}`)).res.status).toBe(400);
    const grey = await get(base, `/badge/discord_application/${longId}.svg?theme=dark`);
    expect(grey.res.status).toBe(200);
    expect(grey.text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
    // At the cap is still fine.
    expect((await get(base, `/v1/status/${'t'.repeat(64)}/app1`)).res.status).toBe(200);
  });

  it('malformed-subject badge responses carry no fabricated check time (400 path too)', async () => {
    const base = await start();
    const badge = await get(base, '/badge/address/0xZZZ.svg?theme=dark');
    expect(badge.res.headers.get('x-checked-at')).toBeNull();
    expect(badge.text).not.toContain('checked ');
    expect(badge.text).not.toContain('data-checked-at');
    const json = await get(base, '/v1/status/address/0xZZZ');
    expect(json.res.status).toBe(400);
    expect(json.res.headers.get('x-checked-at')).toBeNull();
  });
});

describe('fix pass: the 500 path is scanned too', () => {
  it('an induced internal fault returns a fixed 500 body carrying no subject data', async () => {
    const exploding: Verifier = {
      async verifyAddress() {
        throw new Error('unused');
      },
      async verifyAttestation() {
        throw new Error('unused');
      },
      async resolveStatus() {
        // The thrown message deliberately embeds the sensitive
        // values: the 500 body must still be the fixed string.
        throw new Error(`boom ${RAW_HUMAN} ${ADDR}`);
      },
    };
    const base = await start({ verifier: exploding });
    const res = await fetch(`${base}/v1/status/address/${ADDR}`);
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).toBe('{"error":"internal error"}');
    expect(countOccurrences(text, ADDR)).toBe(0);
    expect(text).not.toContain(RAW_HUMAN);
    res.headers.forEach((value) => {
      expect(value).not.toContain(RAW_HUMAN);
      expect(value.toLowerCase()).not.toContain(ADDR.toLowerCase());
    });
  });
});

describe('fix pass: accessible names and the expired layout', () => {
  it('accessible names distinguish states on both variants', async () => {
    const base = await start();
    const verified = await get(base, '/badge/discord_application/app1.svg?theme=dark');
    fake.attestationMode = 'expired';
    const base2 = await start();
    const expired = await get(base2, '/badge/discord_application/app1.svg?theme=dark');
    const unverified = await get(base2, '/badge/discord_application/missing.svg?theme=dark');
    const label = (svg: string) => /aria-label="([^"]+)"/.exec(svg)?.[1];
    expect(label(verified.text)).toBe('Claim unconfirmed');
    expect(label(expired.text)).toContain('expired');
    expect(label(unverified.text)).toContain('not verified');
    expect(label(expired.text)).not.toBe(label(verified.text));
    const iconExpired = await get(base2, '/badge/discord_application/app1.svg?theme=dark&variant=icon');
    expect(label(iconExpired.text)).toContain('expired');
    const iconVerified = await get(base, '/badge/discord_application/app1.svg?theme=dark&variant=icon');
    expect(label(iconVerified.text)).toBe('Claim unconfirmed');
    expect(label(iconExpired.text)).not.toBe(label(iconVerified.text));
  });

  it('the expired tag no longer overprints the check label', async () => {
    fake.attestationMode = 'expired';
    const base = await start();
    const { text } = await get(base, '/badge/discord_application/app1.svg?theme=dark');
    // Tag is left-anchored right after the label; the check label is
    // right-anchored at the pill edge. Their x positions cannot
    // collide for any check-label width.
    expect(text).toContain('<text x="74" y="18"');
    expect(text).toContain('>expired</text>');
    const width = PILL_WIDTHS_FIX();
    expect(text).toContain(`<text x="${width - 10}" y="18" text-anchor="end"`);
    expect(text).not.toContain(`x="${width - 104}"`);
  });
});

function PILL_WIDTHS_FIX(): number {
  return 288; // PILL_WIDTHS.expired, pinned by the palettes module
}

describe('registry refresh races', () => {
  it('does not cache a verification completed after its registry entry was revoked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'badge-reg-race-'));
    const file = join(dir, 'registry.json');
    writeFileSync(file, JSON.stringify({ discord_application: { race: ATTESTATION } }));
    const source = new FileRegistry(file, 'VERIFY_REGISTRY_FILE', {
      now: () => nowRef.current.getTime(),
      refreshMs: 300_000,
      log: () => {},
    });
    source.loadInitial();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let raceCalls = 0;
    const verifier: Verifier = {
      verifyAddress: fake.verifyAddress.bind(fake),
      verifyAttestation: fake.verifyAttestation.bind(fake),
      async resolveStatus(subject) {
        if (subject.kind !== 'attested_subject' || subject.subject.id !== 'race') {
          return fake.resolveStatus(subject);
        }
        raceCalls++;
        const attestation = await subject.resolveAttestation(subject.subject);
        if (raceCalls === 1) {
          entered();
          await gate;
        }
        return attestation ? resultFor('verified') : { ...resultFor('unknown'), failures: ['attestation_not_found'] };
      },
    };
    try {
      const base = await start({ verifier, registrySource: source });
      const first = fetch(`${base}/v1/status/discord_application/race`);
      await started;
      writeFileSync(file, JSON.stringify({ discord_application: {} }));
      nowRef.current = new Date(T0.getTime() + 300_001);
      const second = await get(base, '/v1/status/discord_application/race');
      expect((JSON.parse(second.text) as { failures: string[] }).failures).toContain('attestation_not_found');
      release();
      const oldResponse = await first;
      expect(oldResponse.status).toBe(503);
      expect(oldResponse.headers.get('x-checked-at')).toBeNull();
      await oldResponse.text();
      expect(source.version).toBe(1);
      expect(servers.at(-1)!.badgeInternals.resultCacheSize()).toBe(0);
      const third = await get(base, '/v1/status/discord_application/race');
      expect((JSON.parse(third.text) as { status: string }).status).toBe('unknown');
      expect(raceCalls).toBe(3);
    } finally {
      release();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts a new source lookup after a version change instead of joining the old flight', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let version = 0;
    let resolves = 0;
    const source: RegistrySource = {
      get version() { return version; },
      refreshIfDue(nowMs) { if (nowMs > T0.getTime() + 300_000) version = 1; },
      async resolve() {
        resolves++;
        if (resolves === 1) {
          entered();
          await gate;
          return ATTESTATION;
        }
        return null;
      },
    };
    const base = await start({ registrySource: source, requestTimeoutMs: 300 });
    const first = fetch(`${base}/v1/status/discord_application/race`);
    try {
      await started;
      nowRef.current = new Date(T0.getTime() + 300_001);
      const second = await get(base, '/v1/status/discord_application/race');
      const body = JSON.parse(second.text) as { failures: string[] };
      expect(body.failures).toContain('attestation_not_found');
      expect(resolves).toBe(2);
    } finally {
      release();
      await first;
    }
  });

  it('rejects a pre-expiry HTTPS attestation flight after the registry entry is revoked', async () => {
    const id = '123456789012345678';
    const registryUrl = 'https://registry.example/registry.json';
    const attestationUrl = 'https://attestation.example/claim.json';
    let document: { version: number; entries: Array<{ discord_application_id: string; attestation_url: string; status?: 'revoked' }> } =
      { version: 1, entries: [{ discord_application_id: id, attestation_url: attestationUrl }] };
    let registryFetches = 0;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const resolver = createRegistryResolver({
      url: registryUrl,
      now: () => nowRef.current.getTime(),
      async fetchJson(url) {
        if (url === registryUrl) {
          registryFetches++;
          return document;
        }
        if (url !== attestationUrl) throw new Error('unexpected source URL');
        entered();
        await gate;
        return ATTESTATION;
      },
    });
    // Seed only the registry, leaving the first attestation fetch
    // to start one millisecond before its 300-second source window ends.
    expect(await resolver({ type: 'discord_application', id: '000000000000000000' })).toBeNull();
    nowRef.current = new Date(T0.getTime() + 299_999);
    const base = await start({ resolveAttestation: resolver, sourceVersion: resolver.currentVersion });
    const oldRequest = get(base, `/v1/status/discord_application/${id}`);
    try {
      await started;
      document = { version: 1, entries: [{ discord_application_id: id, attestation_url: attestationUrl, status: 'revoked' }] };
      nowRef.current = new Date(T0.getTime() + 300_001);
      const current = await get(base, `/v1/status/discord_application/${id}`);
      expect(current.res.status).toBe(200);
      expect((JSON.parse(current.text) as { status: string; failures: string[] })).toMatchObject({
        status: 'unknown', failures: ['attestation_not_found'],
      });
      expect(registryFetches).toBe(2);
      release();
      const old = await oldRequest;
      expect(old.res.status).toBe(503);
      expect(old.res.headers.get('x-checked-at')).toBeNull();
      expect(servers.at(-1)!.badgeInternals.resultCacheSize()).toBe(0);
      const later = await get(base, `/v1/status/discord_application/${id}`);
      expect((JSON.parse(later.text) as { status: string }).status).toBe('unknown');
    } finally {
      release();
      await oldRequest;
    }
  });

  it('does not reuse an old verified image after revocation while rate limited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'badge-art-race-'));
    const file = join(dir, 'registry.json');
    writeFileSync(file, JSON.stringify({ service: { race: ATTESTATION } }));
    const source = new FileRegistry(file, 'VERIFY_REGISTRY_FILE', {
      now: () => nowRef.current.getTime(),
      refreshMs: 1_000,
      log: () => {},
    });
    source.loadInitial();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const verifier: Verifier = {
      verifyAddress: fake.verifyAddress.bind(fake),
      verifyAttestation: fake.verifyAttestation.bind(fake),
      async resolveStatus(subject) {
        if (subject.kind === 'attested_subject' && subject.subject.id === 'race') {
          const attestation = await subject.resolveAttestation(subject.subject);
          entered();
          await gate;
          return attestation ? resultFor('verified') : resultFor('unknown');
        }
        return fake.resolveStatus(subject);
      },
    };
    try {
      const base = await start({ verifier, registrySource: source, rateLimitMax: 2, rateLimitWindowMs: 1_000_000 });
      const first = fetch(`${base}/badge/service/race.svg?theme=dark`);
      await started;
      writeFileSync(file, JSON.stringify({ service: {} }));
      nowRef.current = new Date(T0.getTime() + 1_001);
      await get(base, '/v1/status/service/other'); // refresh without using the race gate
      release();
      const oldImage = await first;
      const oldBody = await oldImage.text();
      expect(oldImage.status).toBe(200);
      expect(oldBody).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
      expect(oldBody).not.toContain(`stroke="${PILL_PALETTES.dark.verified.ring}"`);
      expect(oldBody).not.toContain('data-checked-at');
      expect(oldImage.headers.get('x-checked-at')).toBeNull();

      const limited = await get(base, '/badge/service/race.svg?theme=dark');
      expect(limited.res.status).toBe(200);
      expect(limited.text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
      expect(limited.text).not.toContain(`stroke="${PILL_PALETTES.dark.verified.ring}"`);
      expect(limited.res.headers.get('cache-control')).toBe('no-store');
      expect(limited.res.headers.get('x-checked-at')).toBeNull();
    } finally {
      release();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('limited renders and lookup failures', () => {
  it('ends downstream badge freshness before the UTC date label changes', async () => {
    nowRef.current = new Date('2026-10-26T23:59:30.000Z');
    const base = await start();
    const path = `/badge/address/${ADDR}.svg?theme=dark`;
    const first = await get(base, path);
    expect(first.res.headers.get('cache-control')).toBe('public, max-age=30, s-maxage=30');
    expect(first.text).toContain('checked 23:59 UTC');

    // The original checked result is still fresh in the server, but
    // even a one-second CDN lifetime would carry its label past midnight.
    nowRef.current = new Date('2026-10-26T23:59:59.500Z');
    const lastHalfSecond = await get(base, path);
    expect(lastHalfSecond.res.headers.get('cache-control')).toBe('no-store');
    expect(lastHalfSecond.res.headers.get('x-checked-at')).toBe(first.res.headers.get('x-checked-at'));
  });

  it('changes the ETag and visible check date when UTC midnight passes', async () => {
    nowRef.current = new Date('2026-10-26T23:59:00.000Z');
    let renders = 0;
    const base = await start({ onRender: () => renders++ });
    const path = `/badge/address/${ADDR}.svg?theme=dark`;
    const first = await get(base, path);
    expect(first.text).toContain('checked 23:59 UTC');
    expect(first.text).not.toContain('checked 2026-10-26 23:59 UTC');
    const etag = first.res.headers.get('etag');
    expect(etag).not.toBeNull();

    nowRef.current = new Date('2026-10-27T00:01:00.000Z'); // same cached check, new UTC day
    const next = await get(base, path, { 'if-none-match': etag! });
    expect(next.res.status).toBe(200);
    expect(next.res.headers.get('etag')).not.toBe(etag);
    expect(next.text).toContain('checked 2026-10-26 23:59 UTC');
    expect(renders).toBe(2);
    const unchanged = await get(base, path, { 'if-none-match': next.res.headers.get('etag')! });
    expect(unchanged.res.status).toBe(304);
    expect(renders).toBe(2);
  });

  it('uses 503 and an untimed grey image at production defaults when the core never settles', async () => {
    const never: Verifier = {
      verifyAddress: fake.verifyAddress.bind(fake),
      verifyAttestation: fake.verifyAttestation.bind(fake),
      async resolveStatus() { return new Promise<VerifyResult>(() => {}); },
    };
    const base = await start({ verifier: never }); // 5s whole request, 10s lookup deadline
    const [status, image] = await Promise.all([
      fetch(`${base}/v1/status/discord_application/app1`),
      get(base, '/badge/discord_application/app1.svg?theme=dark'),
    ]);
    expect(status.status).toBe(503);
    expect(status.headers.get('cache-control')).toBe('no-store');
    expect(status.headers.get('x-checked-at')).toBeNull();
    expect(await status.text()).toBe('{"error":"service busy"}');
    expect(image.res.status).toBe(200);
    expect(image.text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
    expect(image.text).not.toContain('data-checked-at');
    expect(image.res.headers.get('x-checked-at')).toBeNull();
  }, 12_000);

  it('renders each rate-limited SVG theme and variant only once', async () => {
    let renders = 0;
    const base = await start({ rateLimitMax: 0, onRender: () => renders++ });
    const dark = await get(base, '/badge/discord_application/app1.svg?theme=dark');
    const repeat = await get(base, '/badge/discord_application/app1.svg?theme=dark');
    expect(repeat.text).toBe(dark.text);
    expect(renders).toBe(1);
    const light = await get(base, '/badge/discord_application/app1.svg?theme=light');
    expect(light.text).not.toBe(dark.text);
    expect(renders).toBe(2);
    for (const item of [dark, repeat, light]) {
      expect(item.res.headers.get('cache-control')).toBe('no-store');
      expect(item.res.headers.get('x-checked-at')).toBeNull();
    }
  });

  it('answers 503 at the lookup deadline and discards a signal-ignoring late result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const verifier: Verifier = {
      verifyAddress: fake.verifyAddress.bind(fake),
      verifyAttestation: fake.verifyAttestation.bind(fake),
      async resolveStatus() {
        calls++;
        if (calls === 1) await gate; // deliberately ignores AbortSignal
        return resultFor('verified');
      },
    };
    const base = await start({ verifier, lookupDeadlineMs: 100, requestTimeoutMs: 1000 });
    try {
      const first = await fetch(`${base}/v1/status/discord_application/app1`);
      expect(first.status).toBe(503);
      expect(first.headers.get('cache-control')).toBe('no-store');
      await first.text();
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await get(base, '/v1/status/discord_application/app1');
      expect(second.res.status).toBe(200);
      expect((JSON.parse(second.text) as { status: string }).status).toBe('verified');
      expect(calls).toBe(2);
    } finally {
      release();
    }
  });

  it('answers a never-settling core with 503 JSON and a grey badge', async () => {
    const never: Verifier = {
      verifyAddress: fake.verifyAddress.bind(fake),
      verifyAttestation: fake.verifyAttestation.bind(fake),
      async resolveStatus() { return new Promise<VerifyResult>(() => {}); },
    };
    const base = await start({ verifier: never, lookupDeadlineMs: 100, requestTimeoutMs: 1000 });
    const status = await fetch(`${base}/v1/status/discord_application/app1`);
    expect(status.status).toBe(503);
    expect(status.headers.get('cache-control')).toBe('no-store');
    const badge = await get(base, '/badge/discord_application/app1.svg?theme=dark');
    expect(badge.res.status).toBe(200);
    expect(badge.text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
    expect(badge.res.headers.get('cache-control')).toBe('no-store');
    expect(badge.res.headers.get('x-checked-at')).toBeNull();
  });

  it('renders grey SVG and PNG when the core throws while JSON keeps a fixed 500', async () => {
    const exploding: Verifier = {
      verifyAddress: fake.verifyAddress.bind(fake),
      verifyAttestation: fake.verifyAttestation.bind(fake),
      async resolveStatus() { throw new Error(`boom ${RAW_HUMAN} ${ADDR}`); },
    };
    const base = await start({ verifier: exploding });
    const svg = await get(base, '/badge/discord_application/app1.svg?theme=dark');
    expect(svg.res.status).toBe(200);
    expect(svg.text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
    expect(svg.res.headers.get('cache-control')).toBe('no-store');
    expect(svg.res.headers.get('x-checked-at')).toBeNull();
    const png = await getPng(base, '/badge/discord_application/app1.png?theme=dark');
    expect(png.res.status).toBe(200);
    expect(png.res.headers.get('content-type')).toBe('image/png');
    const json = await fetch(`${base}/v1/status/discord_application/app1`);
    expect(json.status).toBe(500);
    expect(await json.text()).toBe('{"error":"internal error"}');
  });
});
