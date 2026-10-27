import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardedFetchJson, isNonPublicAddress } from '../src/guardedFetch.js';
import { createRegistryResolver } from '../src/registry.js';

const APPLICATION_ID = '123456789012345678';
const ATTESTATION_URL = 'https://attest.example/claim.json';
const REGISTRY_URL = 'https://registry.example/registry.json';
const ATTESTATION = { payload: { subject: { type: 'discord_application', id: APPLICATION_ID } }, signature: '0x00', signatureType: 'eip191' };
const entry = { discord_application_id: APPLICATION_ID, attestation_url: ATTESTATION_URL };
const document = (entries: unknown[]) => ({ version: 1, generated_at: '2026-10-26T00:00:00Z', entries });
const dirs: string[] = [];

function fakeRequest(status: number, body: Buffer | string, contentType = 'application/json') {
  let called = 0;
  let options: Record<string, unknown> | undefined;
  const requestImpl = ((_url: URL, requestOptions: Record<string, unknown>, onResponse: (response: IncomingMessage) => void) => {
    called++;
    options = requestOptions;
    const req = Object.assign(new EventEmitter(), {
      end() {
        queueMicrotask(() => {
          const response = Readable.from([body]) as IncomingMessage;
          response.statusCode = status;
          response.headers = { 'content-type': contentType };
          onResponse(response);
        });
        return req;
      },
      destroy() { return req; },
    }) as unknown as ClientRequest;
    return req;
  }) as unknown as typeof request;
  return { requestImpl, get called() { return called; }, get options() { return options; } };
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('canonical registry source', () => {
  it('shares concurrent fetches and refreshes the registry after 300 seconds', async () => {
    let nowMs = 0;
    let current = document([entry]);
    const fetchJson = vi.fn(async (url: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return url === REGISTRY_URL ? current : ATTESTATION;
    });
    const resolve = createRegistryResolver({ url: REGISTRY_URL, fetchJson, now: () => nowMs });
    const subject = { type: 'discord_application', id: APPLICATION_ID };
    const results = await Promise.all(Array.from({ length: 30 }, () => resolve(subject)));
    expect(results.every((value) => value === ATTESTATION)).toBe(true);
    expect(fetchJson.mock.calls.map(([url]) => url)).toEqual([REGISTRY_URL, ATTESTATION_URL]);
    await resolve(subject);
    expect(fetchJson).toHaveBeenCalledTimes(2);
    nowMs = 300_001;
    current = document([]);
    expect(await resolve(subject)).toBeNull();
    expect(fetchJson.mock.calls.map(([url]) => url)).toEqual([REGISTRY_URL, ATTESTATION_URL, REGISTRY_URL]);
  });

  it('refreshes an attestation at the same URL after its own 300-second window', async () => {
    let nowMs = 0;
    let currentAttestation = ATTESTATION;
    const fetchJson = vi.fn(async (url: string) =>
      url === REGISTRY_URL ? document([entry]) : currentAttestation);
    const resolve = createRegistryResolver({ url: REGISTRY_URL, fetchJson, now: () => nowMs });
    const subject = { type: 'discord_application', id: APPLICATION_ID };
    expect(await resolve(subject)).toBe(ATTESTATION);
    currentAttestation = { ...ATTESTATION, signature: '0x01' };
    expect(await resolve(subject)).toBe(ATTESTATION);
    nowMs = 300_000;
    expect(await resolve(subject)).toBe(currentAttestation);
    expect(fetchJson.mock.calls.map(([url]) => url)).toEqual([
      REGISTRY_URL, ATTESTATION_URL, REGISTRY_URL, ATTESTATION_URL,
    ]);
  });

  it('reads entries[] and observes removal and revocation without a restart', async () => {
    let nowMs = 0;
    const dir = await mkdtemp(join(tmpdir(), 'fiador-badge-registry-'));
    dirs.push(dir);
    const file = join(dir, 'registry.json');
    const fetchJson = vi.fn(async (url: string) => {
      expect(url).toBe(ATTESTATION_URL);
      return ATTESTATION;
    });
    const resolve = createRegistryResolver({ file, fetchJson, now: () => nowMs });
    const subject = { type: 'discord_application', id: APPLICATION_ID };
    await writeFile(file, JSON.stringify(document([entry])));
    expect(await resolve(subject)).toEqual(ATTESTATION);
    await writeFile(file, JSON.stringify(document([])));
    expect(await resolve(subject)).toEqual(ATTESTATION); // source window remains valid
    nowMs = 300_001;
    expect(await resolve(subject)).toBeNull();
    await writeFile(file, JSON.stringify(document([{ ...entry, status: 'revoked' }])));
    nowMs = 600_002;
    expect(await resolve(subject)).toBeNull();
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it('accepts a configured HTTPS registry URL and fetches its attestation', async () => {
    const fetchJson = vi.fn(async (url: string) => url === REGISTRY_URL ? document([entry]) : ATTESTATION);
    const resolve = createRegistryResolver({ url: REGISTRY_URL, fetchJson });
    expect(await resolve({ type: 'discord_application', id: APPLICATION_ID })).toEqual(ATTESTATION);
    expect(fetchJson.mock.calls.map(([url]) => url)).toEqual([REGISTRY_URL, ATTESTATION_URL]);
  });

  it('rejects duplicate IDs and non-HTTPS attestation URLs', async () => {
    const resolveDuplicate = createRegistryResolver({
      url: REGISTRY_URL,
      fetchJson: async () => document([entry, entry]),
    });
    await expect(resolveDuplicate({ type: 'discord_application', id: APPLICATION_ID })).rejects.toThrow();
    const resolveUnsafe = createRegistryResolver({
      url: REGISTRY_URL,
      fetchJson: async () => document([{ ...entry, attestation_url: 'http://127.0.0.1/private' }]),
    });
    await expect(resolveUnsafe({ type: 'discord_application', id: APPLICATION_ID })).rejects.toThrow();
  });
});

describe('outbound fetch guard', () => {
  it('rejects private, metadata, and IPv4-mapped IPv6 destinations', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::ffff:7f00:1']) {
      expect(isNonPublicAddress(ip)).toBe(true);
    }
    await expect(guardedFetchJson('https://127.0.0.1/private')).rejects.toThrow();
  });

  it('pins a vetted address and rejects redirects, non-JSON, and oversized responses', async () => {
    const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 as const }];
    const good = fakeRequest(200, '{"ok":true}');
    expect(await guardedFetchJson(ATTESTATION_URL, { lookupImpl, requestImpl: good.requestImpl })).toEqual({ ok: true });
    const pinnedLookup = good.options?.lookup as (
      host: string, options: object,
      callback: (error: Error | null, address: string, family: number) => void,
    ) => void;
    pinnedLookup('attest.example', {}, (_error, address) => expect(address).toBe('93.184.216.34'));
    for (const bad of [
      fakeRequest(302, ''),
      fakeRequest(200, '{}', 'text/plain'),
      fakeRequest(200, Buffer.alloc(64 * 1024 + 1)),
    ]) {
      await expect(guardedFetchJson(ATTESTATION_URL, { lookupImpl, requestImpl: bad.requestImpl })).rejects.toThrow();
      expect(bad.called).toBe(1);
    }
  });
});
