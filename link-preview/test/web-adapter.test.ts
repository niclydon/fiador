import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SignedAttestation } from '@fiador/verify';
import { handlePreviewRequest } from '../../api/preview.js';
import { failClosedVerifier } from '../src/default-deps.js';
import type { LinkPreviewDeps } from '../src/deps.js';
import { attestationShortId } from '../src/shortId.js';

const claim = JSON.parse(
  await readFile(new URL('../../verify-page/attestations/nova.json', import.meta.url), 'utf8'),
) as SignedAttestation;
const id = attestationShortId(claim);
const clock = new Date('2026-10-26T12:00:00Z');

function deps(): LinkPreviewDeps {
  return {
    baseUrl: 'https://ignored.invalid',
    now: () => clock,
    // The root adapter must replace this with the bundled canonical registry.
    registrySource: async () => { throw new Error('Unexpected registry source'); },
    attestationFetcher: async () => claim,
    verifier: failClosedVerifier,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('root Vercel preview adapter', () => {
  it('sends a browser to this protected preview and its static verify page', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('VERCEL_URL', 'fiador-preview.example.vercel.app');
    const response = await handlePreviewRequest(
      new Request(`https://fiador-preview.example.vercel.app/api/preview?fiador_id=${id}`),
      deps(),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe('https://fiador-preview.example.vercel.app');
    expect(location.pathname).toBe('/verify/');
    expect(location.searchParams.get('attestation')).toBe(claim.payload.attestationUrl);
  });

  it('serves crawler meta and card from the preview origin without a self-fetch', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('VERCEL_URL', 'fiador-preview.example.vercel.app');
    const page = await handlePreviewRequest(
      new Request(`https://fiador-preview.example.vercel.app/api/preview?fiador_id=${id}`, {
        headers: { 'user-agent': 'Discordbot/2.0' },
      }),
      deps(),
    );
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    expect(html).toContain(`https://fiador-preview.example.vercel.app/v/${id}/card.svg`);
    expect(html).toContain('Could not check');
    expect(html).not.toContain(claim.payload.agentWalletAddress);

    const card = await handlePreviewRequest(
      new Request(`https://fiador-preview.example.vercel.app/api/preview?fiador_id=${id}&fiador_card=1`),
      deps(),
    );
    expect(card.status).toBe(200);
    expect(card.headers.get('content-type')).toContain('image/svg+xml');
    expect(await card.text()).toContain('Could not check');
  });

  it('keeps crawler HTML and browser redirects at the same URL out of shared caches', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('VERCEL_URL', 'fiador-preview.example.vercel.app');
    const url = 'https://fiador-preview.example.vercel.app/api/preview?fiador_id=bbbbbbbbbb';

    const crawler = await handlePreviewRequest(
      new Request(url, { headers: { 'user-agent': 'Discordbot/2.0' } }),
      deps(),
    );
    expect(crawler.status).toBe(200);
    expect(crawler.headers.get('content-type')).toContain('text/html');
    expect(crawler.headers.get('cache-control')).toBe('no-store');
    expect(await crawler.text()).toContain('Attestation not found');

    const browser = await handlePreviewRequest(
      new Request(url, { headers: { 'user-agent': 'Mozilla/5.0' } }),
      deps(),
    );
    expect(browser.status).toBe(302);
    expect(browser.headers.get('location')).toBe('https://fiador-preview.example.vercel.app/verify/');
    expect(browser.headers.get('cache-control')).toBe('no-store');

    const card = await handlePreviewRequest(
      new Request(`${url}&fiador_card=1`),
      deps(),
    );
    expect(card.status).toBe(200);
    expect(card.headers.get('content-type')).toContain('image/svg+xml');
    expect(card.headers.get('cache-control')).toBe('no-store');
    expect(await card.text()).toContain('Attestation not found');
  });

  it('rejects an invalid route id before loading dependencies', async () => {
    const response = await handlePreviewRequest(
      new Request('https://example.invalid/api/preview?fiador_id=invalid%2Fpath'),
      deps(),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('fails rather than redirecting a preview visitor to production without its URL', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('VERCEL_URL', '');
    await expect(handlePreviewRequest(
      new Request(`https://example.invalid/api/preview?fiador_id=${id}`),
      deps(),
    )).rejects.toThrow('VERCEL_URL is required');
  });
});
