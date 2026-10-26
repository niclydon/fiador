import { EventEmitter } from 'node:events';
import { request } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FetchGuardError,
  guardedFetchJson,
  isNonPublicAddress,
  type DnsLookup,
} from '../src/fetchGuard.js';

const publicLookup: DnsLookup = async () => ['93.184.216.34'];

function fakeRequest(status: number, body: string | Buffer, headers: Record<string, string> = {}) {
  let called = 0;
  let destroyed = 0;
  let options: RequestOptions | undefined;
  let response: IncomingMessage | undefined;
  const requestImpl = ((_url: URL, requestOptions: RequestOptions, onResponse: (value: IncomingMessage) => void) => {
    called++;
    options = requestOptions;
    const req = Object.assign(new EventEmitter(), {
      end() {
        queueMicrotask(() => {
          response = Readable.from([body]) as IncomingMessage;
          response.statusCode = status;
          response.headers = { 'content-type': 'application/json', ...headers };
          onResponse(response);
        });
        return req;
      },
      destroy() {
        destroyed++;
        return req;
      },
    }) as unknown as ClientRequest;
    return req;
  }) as typeof request;
  return {
    requestImpl,
    get called() { return called; },
    get destroyed() { return destroyed; },
    get options() { return options; },
    get response() { return response; },
  };
}

async function expectGuardCode(promise: Promise<unknown>, code: FetchGuardError['code']) {
  await expect(promise).rejects.toMatchObject({ code });
}

type LookupReply = (
  error: Error | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

afterEach(() => vi.useRealTimers());

describe('guardedFetchJson — SSRF guard (DESIGN §5.4)', () => {
  it('rejects non-HTTPS and private literal hosts before connecting', async () => {
    const transport = fakeRequest(200, '{}');
    await expectGuardCode(guardedFetchJson('http://example.com/attestation.json', {
      lookupImpl: publicLookup, requestImpl: transport.requestImpl,
    }), 'not_https');
    for (const url of [
      'https://127.0.0.1/attestation.json',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/attestation.json',
      'https://[::ffff:7f00:1]/attestation.json',
    ]) {
      await expectGuardCode(guardedFetchJson(url, {
        lookupImpl: publicLookup, requestImpl: transport.requestImpl,
      }), 'private_address');
    }
    expect(transport.called).toBe(0);
  });

  it('rejects any private DNS answer, including mixed public/private answers', async () => {
    const transport = fakeRequest(200, '{}');
    await expectGuardCode(guardedFetchJson('https://sneaky.example.com/file.json', {
      lookupImpl: async () => ['93.184.216.34', '10.0.0.5'],
      requestImpl: transport.requestImpl,
    }), 'private_address');
    expect(transport.called).toBe(0);
  });

  it('pins the vetted address for the HTTPS socket even if DNS then flips private', async () => {
    const transport = fakeRequest(200, '{"ok":true}');
    let dnsCalls = 0;
    const result = await guardedFetchJson('https://attest.example/file.json', {
      lookupImpl: async () => (++dnsCalls === 1 ? ['93.184.216.34'] : ['127.0.0.1']),
      requestImpl: transport.requestImpl,
    });
    expect(result).toEqual({ ok: true });
    expect(dnsCalls).toBe(1);
    expect(transport.called).toBe(1);
    expect(transport.options).toMatchObject({ agent: false, servername: 'attest.example' });
    const pinnedLookup = transport.options?.lookup as (
      host: string,
      options: { all?: boolean },
      callback: LookupReply,
    ) => void;
    pinnedLookup('attest.example', { all: true }, (error, addresses) => {
      expect(error).toBeNull();
      expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
    });
    pinnedLookup('attest.example', {}, (error, address, family) => {
      expect(error).toBeNull();
      expect(address).toBe('93.184.216.34');
      expect(family).toBe(4);
    });
    expect(dnsCalls).toBe(1);
  });

  it('refuses redirects without issuing another request', async () => {
    const transport = fakeRequest(302, '', { location: 'https://example.com/final.json' });
    await expectGuardCode(guardedFetchJson('https://example.com/start.json', {
      lookupImpl: publicLookup, requestImpl: transport.requestImpl,
    }), 'redirect_refused');
    expect(transport.called).toBe(1);
    expect(transport.destroyed).toBe(1);
    expect(transport.response?.destroyed).toBe(true);
  });

  it('closes an oversized response, including an oversized declared length', async () => {
    for (const transport of [
      fakeRequest(200, Buffer.alloc(64 * 1024 + 1)),
      fakeRequest(200, '', { 'content-length': String(64 * 1024 + 1) }),
    ]) {
      await expectGuardCode(guardedFetchJson('https://example.com/big.json', {
        lookupImpl: publicLookup, requestImpl: transport.requestImpl,
      }), 'body_too_large');
      expect(transport.destroyed).toBe(1);
      expect(transport.response?.destroyed).toBe(true);
    }
  });

  it('bounds DNS resolution by the request deadline', async () => {
    vi.useFakeTimers();
    const pending = guardedFetchJson('https://example.com/file.json', {
      lookupImpl: async () => new Promise(() => undefined),
      requestImpl: fakeRequest(200, '{}').requestImpl,
    });
    const rejection = expectGuardCode(pending, 'timeout');
    await vi.advanceTimersByTimeAsync(5000);
    await rejection;
  });
});

describe('isNonPublicAddress', () => {
  it('rejects private, mapped-private, and IPv6 transition destinations', () => {
    for (const ip of [
      '127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1',
      '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fd00::1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '2002::1', '2001:db8::1',
    ]) {
      expect(isNonPublicAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isNonPublicAddress(ip), ip).toBe(false);
    }
  });
});
