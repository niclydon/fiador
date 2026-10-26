import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDeps } from '../src/default-deps.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('default preview wiring', () => {
  it('loads the registry from the published root URL', async () => {
    const fetchStub = vi.fn(async () =>
      new Response(JSON.stringify({ version: 1, entries: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchStub);

    await createDefaultDeps().registrySource();

    expect(fetchStub).toHaveBeenCalledWith(
      'https://fiador.org/registry.json',
      expect.objectContaining({
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('rejects a registry response over 64 KiB', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ version: 1, entries: [], padding: 'x'.repeat(70_000) }), {
        status: 200,
      }),
    ));
    await expect(createDefaultDeps().registrySource()).rejects.toThrow('64 KiB');
  });

  it('rejects an operator-controlled non-HTTPS attestation URL before fetching', async () => {
    const fetchStub = vi.fn(async () =>
      new Response(JSON.stringify({ payload: {}, signature: '0x00' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchStub);

    await expect(
      createDefaultDeps().attestationFetcher('http://127.0.0.1/private'),
    ).rejects.toThrow();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('uses the verify core by default, including its local validation', async () => {
    const result = await createDefaultDeps().verifier.verifyAddress('not-an-address');
    expect(result.status).toBe('invalid');
    expect(result.failures).toContain('malformed_address');
  });
});
