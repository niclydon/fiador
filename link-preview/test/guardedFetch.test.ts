import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { guardedFetchJson, isNonPublicAddress } from '../src/guardedFetch.js';

const publicAddress = { address: '93.184.216.34', family: 4 as const };

function fakeRequest(status: number, body: string | Buffer, headers: Record<string, string> = {}) {
  let called = 0;
  let requestDestroyed = 0;
  let response: IncomingMessage | undefined;
  let options: Record<string, unknown> | undefined;
  const requestImpl = ((_url: URL, requestOptions: Record<string, unknown>, onResponse: (response: IncomingMessage) => void) => {
    called += 1;
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
        requestDestroyed += 1;
        return req;
      },
    }) as unknown as ClientRequest;
    return req;
  }) as unknown as typeof request;
  return {
    requestImpl,
    get called() { return called; },
    get options() { return options; },
    get requestDestroyed() { return requestDestroyed; },
    get response() { return response; },
  };
}

type LookupReply = (
  error: Error | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

describe('real HTTPS socket behavior', () => {
  let tempDir: string;
  let certificate: Buffer;
  let server: ReturnType<typeof createServer>;
  let streamClosed: (() => void) | undefined;
  let stallReceived: (() => void) | undefined;
  let stallClosed: (() => void) | undefined;
  const lookupCalls: Array<{ all: boolean; result: unknown }> = [];

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fiador-preview-tls-'));
    const keyPath = join(tempDir, 'key.pem');
    const certPath = join(tempDir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
      '-keyout', keyPath, '-out', certPath,
      '-subj', '/CN=attest.example', '-addext', 'subjectAltName=DNS:attest.example',
    ], { stdio: 'ignore' });
    certificate = readFileSync(certPath);
    server = createServer({ key: readFileSync(keyPath), cert: certificate }, (req, res) => {
      if (req.url === '/stall') {
        req.socket.on('close', () => stallClosed?.());
        stallReceived?.();
        return; // The caller's scan deadline must close this socket.
      }
      if (req.url === '/stream') {
        res.on('close', () => streamClosed?.());
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(Buffer.alloc(64 * 1024));
        res.write(Buffer.alloc(1));
        return; // Keep the response open until the client enforces its cap.
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Test-only routing shim: the guard vets a synthetic public address,
  // while the actual TLS socket connects to an ephemeral loopback server.
  // The original lookup callback still runs with Node's real options.
  function localHttpsRequest(
    url: URL,
    options: RequestOptions,
    onResponse: (response: IncomingMessage) => void,
  ): ClientRequest {
    const originalLookup = options.lookup as (
      hostname: string,
      options: { all?: boolean },
      callback: LookupReply,
    ) => void;
    const forwardedLookup = (
      hostname: string,
      lookupOptions: { all?: boolean },
      callback: LookupReply,
    ) => {
      originalLookup(hostname, lookupOptions, (error, result) => {
        lookupCalls.push({ all: lookupOptions.all === true, result });
        if (error) return callback(error, '');
        if (lookupOptions.all) {
          if (!Array.isArray(result)) return callback(new Error('Node expected an address array.'), '');
          return callback(null, [{ address: '127.0.0.1', family: 4 }]);
        }
        callback(null, '127.0.0.1', 4);
      });
    };
    return request(url, {
      ...options,
      port: (server.address() as AddressInfo).port,
      ca: certificate,
      lookup: forwardedLookup as RequestOptions['lookup'],
    }, onResponse);
  }

  it('uses Node 22 all-address lookup and completes a pinned TLS request', async () => {
    const result = await guardedFetchJson('https://attest.example/file.json', {
      lookupImpl: async () => [publicAddress],
      requestImpl: localHttpsRequest as typeof request,
    });
    expect(result).toEqual({ ok: true });
    expect(lookupCalls).toContainEqual({
      all: true,
      result: [publicAddress],
    });
  });

  it('closes the live socket when a chunked response exceeds 64 KiB', async () => {
    const closed = new Promise<void>((resolve) => { streamClosed = resolve; });
    await expect(guardedFetchJson('https://attest.example/stream', {
      lookupImpl: async () => [publicAddress],
      requestImpl: localHttpsRequest as typeof request,
    })).rejects.toThrow('exceeds 64 KiB');
    await closed;
    streamClosed = undefined;
  });

  it('closes the live socket when the registry scan is cancelled', async () => {
    const received = new Promise<void>((resolve) => { stallReceived = resolve; });
    const closed = new Promise<void>((resolve) => { stallClosed = resolve; });
    const controller = new AbortController();
    const pending = guardedFetchJson('https://attest.example/stall', {
      lookupImpl: async () => [publicAddress],
      requestImpl: localHttpsRequest as typeof request,
      signal: controller.signal,
    });
    await received;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await closed;
    stallReceived = undefined;
    stallClosed = undefined;
  });
});

afterEach(() => vi.useRealTimers());

describe('guarded attestation fetch', () => {
  it('pins a vetted DNS address in the HTTPS connection', async () => {
    const transport = fakeRequest(200, '{"ok":true}');
    const result = await guardedFetchJson('https://attest.example/attestation.json', {
      lookupImpl: async () => [publicAddress],
      requestImpl: transport.requestImpl,
    });
    expect(result).toEqual({ ok: true });
    expect(transport.called).toBe(1);
    expect(transport.options).toMatchObject({
      agent: false,
      servername: 'attest.example',
    });
    const pinnedLookup = transport.options?.lookup as (
      hostname: string,
      options: object,
      callback: (error: Error | null, address: string, family: number) => void,
    ) => void;
    let connectedAddress: string | undefined;
    pinnedLookup('attest.example', {}, (error, address, family) => {
      expect(error).toBeNull();
      expect(family).toBe(4);
      connectedAddress = address;
    });
    expect(connectedAddress).toBe(publicAddress.address);
  });

  it('refuses private literals, credentials, and any private DNS answer before connecting', async () => {
    const transport = fakeRequest(200, '{}');
    for (const url of [
      'http://attest.example/file.json',
      'https://127.0.0.1/file.json',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/file.json',
      'https://[::ffff:7f00:1]/file.json',
      'https://user:pass@attest.example/file.json',
    ]) {
      await expect(guardedFetchJson(url, { requestImpl: transport.requestImpl })).rejects.toThrow();
    }
    await expect(guardedFetchJson('https://attest.example/file.json', {
      lookupImpl: async () => [publicAddress, { address: '10.0.0.1', family: 4 }],
      requestImpl: transport.requestImpl,
    })).rejects.toThrow();
    expect(transport.called).toBe(0);
  });

  it('refuses redirects and bodies over 64 KiB', async () => {
    const lookupImpl = async () => [publicAddress];
    await expect(guardedFetchJson('https://attest.example/file.json', {
      lookupImpl,
      requestImpl: fakeRequest(302, '').requestImpl,
    })).rejects.toThrow();
    await expect(guardedFetchJson('https://attest.example/file.json', {
      lookupImpl,
      requestImpl: fakeRequest(200, Buffer.alloc(64 * 1024 + 1)).requestImpl,
    })).rejects.toThrow();
  });

  it('destroys the request and response on a redirect or oversized Content-Length', async () => {
    for (const transport of [
      fakeRequest(302, 'redirecting'),
      fakeRequest(200, '', { 'content-length': String(64 * 1024 + 1) }),
    ]) {
      await expect(guardedFetchJson('https://attest.example/file.json', {
        lookupImpl: async () => [publicAddress],
        requestImpl: transport.requestImpl,
      })).rejects.toThrow();
      expect(transport.response?.destroyed).toBe(true);
      expect(transport.requestDestroyed).toBe(1);
    }
  });

  it('bounds DNS resolution within five seconds', async () => {
    vi.useFakeTimers();
    const pending = guardedFetchJson('https://attest.example/file.json', {
      lookupImpl: async () => new Promise(() => undefined),
      requestImpl: fakeRequest(200, '{}').requestImpl,
    });
    const rejection = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5000);
    await rejection;
  });
});

describe('address classification', () => {
  it('refuses special ranges while accepting public IPv4 and IPv6', () => {
    for (const address of [
      '127.0.0.1', '10.2.3.4', '172.16.0.1', '192.168.1.1',
      '169.254.169.254', '::1', 'fd00::1', 'fe80::1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '2001:db8::1',
    ]) expect(isNonPublicAddress(address), address).toBe(true);
    for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) {
      expect(isNonPublicAddress(address), address).toBe(false);
    }
  });
});
