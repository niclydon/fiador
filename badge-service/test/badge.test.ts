import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import { createVerifier, hashHumanId, type SignedAttestation, type VerifyResult, type Verifier } from '@fiador/verify';
import { createBadgeService, type BadgeServiceDeps } from '../src/service.js';
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

function assertNoLeak(body: string, headers: Headers, opts: { addressSubject?: boolean } = {}): void {
  expect(body).not.toContain(RAW_HUMAN);
  expect(body).not.toContain('"humanId"');
  // For an `address` subject, the address IS the subject identifier
  // the caller placed in the URL: its permitted occurrences are the
  // subject echo and the badge URLs derived from it (SPEC 4.9: a
  // status URL carries subject type, subject ID, and nothing else
  // identifying). Everywhere else — every result field — the full
  // address must never appear; only the truncated form may.
  let scanned = body.toLowerCase();
  if (opts.addressSubject) {
    scanned = scanned.split(ADDR.toLowerCase()).join('');
  }
  expect(scanned).not.toContain(ADDR.toLowerCase());
  headers.forEach((value) => {
    expect(value).not.toContain(RAW_HUMAN);
    expect(value.toLowerCase()).not.toContain(ADDR.toLowerCase());
  });
}

async function get(base: string, path: string, headers: Record<string, string> = {}, opts: { addressSubject?: boolean } = {}) {
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text();
  assertNoLeak(text, res.headers, opts);
  return { res, text };
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
    const { text } = await get(base, `/v1/status/address/${ADDR}`, {}, { addressSubject: true });
    expect((JSON.parse(text) as { status: string }).status).toBe('verified');
    const svg = await get(base, `/badge/address/${ADDR}.svg?theme=light`, {}, { addressSubject: true });
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
    nowRef.current = new Date(T0.getTime() + 301_000);
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
  it('uses the actual client for rate limits when a trusted proxy appends X-Forwarded-For', async () => {
    const base = await start({ rateLimitMax: 1, trustedProxyIps: ['127.0.0.1'] } as Partial<BadgeServiceDeps>);
    const first = await get(base, '/v1/status/discord_application/app1', { 'x-forwarded-for': '198.51.100.10' });
    const second = await get(base, '/v1/status/discord_application/app1', { 'x-forwarded-for': '198.51.100.11' });
    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    const limited = await get(base, '/v1/status/discord_application/app1', { 'x-forwarded-for': '1.2.3.4, 198.51.100.10' });
    expect(limited.res.status).toBe(429);
  });

  it('ignores forwarded addresses from untrusted peers', async () => {
    const base = await start({ rateLimitMax: 1 });
    const first = await get(base, '/v1/status/discord_application/app1', { 'x-forwarded-for': '198.51.100.10' });
    const second = await get(base, '/v1/status/discord_application/app1', { 'x-forwarded-for': '198.51.100.11' });
    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(429);
  });

  it('rate limit: 429 on JSON, grey no-store badge on image routes', async () => {
    const base = await start({ rateLimitMax: 3 });
    for (let i = 0; i < 3; i++) await get(base, '/v1/status/discord_application/app1');
    const limited = await get(base, '/v1/status/discord_application/app1');
    expect(limited.res.status).toBe(429);

    const badgeBase = await start({ rateLimitMax: 1 });
    const first = await get(badgeBase, '/badge/discord_application/app1.svg?theme=dark');
    expect(first.text).toContain('Claim unconfirmed');
    const limitedBadge = await get(badgeBase, '/badge/discord_application/app1.svg?theme=dark');
    expect(limitedBadge.res.status).toBe(200);
    expect(limitedBadge.text).toContain(`stroke="${PILL_PALETTES.dark.unverified.ring}"`);
    expect(limitedBadge.res.headers.get('cache-control')).toBe('no-store');
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
