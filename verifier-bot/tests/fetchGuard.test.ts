import { describe, expect, it } from 'vitest';
import {
  FetchGuardError,
  guardedFetchJson,
  isNonPublicAddress,
  type DnsLookup,
} from '../src/fetchGuard.js';

const publicLookup: DnsLookup = async () => ['93.184.216.34'];
const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

async function expectGuardCode(promise: Promise<unknown>, code: FetchGuardError['code']) {
  await expect(promise).rejects.toBeInstanceOf(FetchGuardError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('guardedFetchJson — SSRF guard (DESIGN §5.4)', () => {
  it('rejects plain http URLs before any fetch', async () => {
    let fetched = false;
    await expectGuardCode(
      guardedFetchJson('http://example.com/attestation.json', {
        lookupImpl: publicLookup,
        fetchImpl: async () => {
          fetched = true;
          return jsonResponse({});
        },
      }),
      'not_https',
    );
    expect(fetched).toBe(false);
  });

  it('rejects a private/loopback IP literal host', async () => {
    await expectGuardCode(
      guardedFetchJson('https://127.0.0.1/attestation.json', {
        lookupImpl: publicLookup,
        fetchImpl: async () => jsonResponse({}),
      }),
      'private_address',
    );
    await expectGuardCode(
      guardedFetchJson('https://169.254.169.254/latest/meta-data', {
        lookupImpl: publicLookup,
        fetchImpl: async () => jsonResponse({}),
      }),
      'private_address',
    );
  });

  it('rejects a public hostname that resolves to a private address', async () => {
    await expectGuardCode(
      guardedFetchJson('https://sneaky.example.com/attestation.json', {
        lookupImpl: async () => ['10.0.0.5'],
        fetchImpl: async () => jsonResponse({}),
      }),
      'private_address',
    );
  });

  it('rejects an oversize body', async () => {
    await expectGuardCode(
      guardedFetchJson('https://example.com/big.json', {
        lookupImpl: publicLookup,
        fetchImpl: async () =>
          new Response('x'.repeat(300 * 1024), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
      'body_too_large',
    );
  });

  it('refuses any redirect: a 3xx is a failed fetch (DESIGN §5.4)', async () => {
    let calls = 0;
    await expectGuardCode(
      guardedFetchJson('https://example.com/loop.json', {
        lookupImpl: publicLookup,
        fetchImpl: async () => {
          calls++;
          return new Response(null, {
            status: 302,
            headers: { location: 'https://example.com/loop.json' },
          });
        },
      }),
      'redirect_refused',
    );
    expect(calls).toBe(1); // never followed, not even once
  });

  it('refuses a redirect even to a vetted-looking target', async () => {
    await expectGuardCode(
      guardedFetchJson('https://example.com/start.json', {
        lookupImpl: publicLookup,
        fetchImpl: async () =>
          new Response(null, {
            status: 301,
            headers: { location: 'https://example.com/final.json' },
          }),
      }),
      'redirect_refused',
    );
  });

  it('fetches and parses JSON from a vetted public URL', async () => {
    const doc = await guardedFetchJson('https://example.com/attestation.json', {
      lookupImpl: publicLookup,
      fetchImpl: async () => jsonResponse({ payload: { version: 1 }, signature: '0xabc' }),
    });
    expect(doc).toEqual({ payload: { version: 1 }, signature: '0xabc' });
  });
});

describe('isNonPublicAddress', () => {
  it('classifies the ranges the guard must refuse', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.9',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isNonPublicAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isNonPublicAddress(ip), ip).toBe(false);
    }
  });
});
