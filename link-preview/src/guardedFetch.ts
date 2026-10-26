// The /v/ service fetches URLs published by registry contributors. Resolve
// and vet every address, then pin the vetted address at connect time: a
// separate check followed by global fetch would allow DNS rebinding.

import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import type { ClientRequest, IncomingMessage } from 'node:http';

const MAX_BODY_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 5000;

export interface AddressRecord {
  address: string;
  family: 4 | 6;
}

export interface GuardedFetchOptions {
  lookupImpl?: (hostname: string) => Promise<AddressRecord[]>;
  requestImpl?: typeof request;
  signal?: AbortSignal;
}

const defaultLookup = async (hostname: string): Promise<AddressRecord[]> =>
  lookup(hostname, { all: true, verbatim: true }) as Promise<AddressRecord[]>;

function inV4Range(ip: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (base & mask);
}

function v4Number(address: string): number {
  return address.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);
}

/** Reject non-public destinations, including IPv4-mapped IPv6 hosts. */
export function isNonPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const ip = v4Number(address);
    const blocked: Array<[string, number]> = [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ];
    return blocked.some(([base, bits]) => inV4Range(ip, v4Number(base), bits));
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    const mappedV4 = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedV4) return isNonPublicAddress(mappedV4[1]);
    // Public IPv6 unicast is 2000::/3. Exclude transition and
    // documentation ranges even though they fall inside that prefix.
    const first = parseInt(lower.split(':')[0], 16);
    if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return true;
    if (first === 0x2002) return true; // 6to4
    if (first === 0x2001) {
      const second = parseInt(lower.split(':')[1] || '0', 16);
      if (second === 0 || second === 0x0db8) return true; // Teredo, docs
    }
    return false;
  }
  return true;
}

function parseTarget(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid attestation URL.');
  }
  if (url.protocol !== 'https:') throw new Error('Attestation URL must use HTTPS.');
  if (url.username || url.password) throw new Error('Attestation URL cannot contain credentials.');
  return url;
}

async function readJson(response: IncomingMessage, req: ClientRequest): Promise<unknown> {
  const declaredLength = Number(response.headers['content-length']);
  if (declaredLength > MAX_BODY_BYTES) {
    response.destroy();
    req.destroy();
    throw new Error('Attestation body exceeds 64 KiB.');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_BODY_BYTES) {
      response.destroy();
      req.destroy();
      throw new Error('Attestation body exceeds 64 KiB.');
    }
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** HTTPS JSON fetch with address pinning, no redirects, 5 s total timeout, 64 KiB cap. */
export async function guardedFetchJson(
  rawUrl: string,
  options: GuardedFetchOptions = {},
): Promise<unknown> {
  const url = parseTarget(rawUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const abort = new AbortController();
  const onExternalAbort = () => abort.abort();
  if (options.signal?.aborted) abort.abort();
  else options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    if (abort.signal.aborted) throw new Error('Attestation fetch timed out.');
    const records = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
      : await Promise.race([
          (options.lookupImpl ?? defaultLookup)(hostname),
          new Promise<never>((_, reject) => {
            abort.signal.addEventListener('abort', () => reject(new Error('Attestation fetch timed out.')), {
              once: true,
            });
          }),
        ]);
    if (records.length === 0) throw new Error('Attestation host has no addresses.');
    if (records.some((record) =>
      record.family !== isIP(record.address) || isNonPublicAddress(record.address)
    )) {
      throw new Error('Attestation host resolves to a non-public address.');
    }
    const pinned = records[0];
    return await new Promise<unknown>((resolve, reject) => {
      const req = (options.requestImpl ?? request)(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        agent: false,
        signal: abort.signal,
        servername: hostname,
        lookup: (_host, _lookupOptions, callback) => {
          if (_lookupOptions.all) {
            const reply = callback as (
              error: NodeJS.ErrnoException | null,
              addresses: AddressRecord[],
            ) => void;
            reply(null, [pinned]);
          } else {
            callback(null, pinned.address, pinned.family);
          }
        },
      }, (response) => {
        if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy();
          req.destroy();
          reject(new Error('Attestation fetch returned a non-success status.'));
          return;
        }
        void readJson(response, req).then(resolve, reject);
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}
