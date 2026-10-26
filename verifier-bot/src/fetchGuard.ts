// SSRF-guarded fetcher for operator-influenced URLs (DESIGN §5.4).
//
// Every URL the bot fetches because an operator or a registry pointed at
// it goes through here. The guard, in order:
//   1. HTTPS only. No credentials in the URL.
//   2. The hostname is resolved first; if ANY resolved address is
//      loopback, RFC1918, link-local (incl. the cloud metadata range),
//      unique-local, or otherwise non-public, the fetch is refused.
//      Literal IP hosts are checked directly, without resolution. The
//      HTTPS socket uses a vetted address, so DNS cannot change after
//      the check; TLS still validates the original hostname.
//   3. No redirect following (DESIGN §5.4): a 3xx is a failed fetch,
//      because the redirect target was never vetted. Operators host
//      the attestation at its final URL.
//   4. 5s total deadline (including DNS); 64 KiB body cap while reading.
//   5. The body must parse as JSON; a JSON content type is expected
//      but not required (the parse attempt decides, per §5.4).
//
// Both the HTTPS transport and the DNS lookup are injectable so the
// guard is fully testable without network access.

import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import type { ClientRequest, IncomingMessage } from 'node:http';

export const MAX_BODY_BYTES = 64 * 1024;
export const FETCH_TIMEOUT_MS = 5000;

export type DnsLookup = (hostname: string) => Promise<string[]>;

export interface GuardedFetchOptions {
  requestImpl?: typeof request;
  lookupImpl?: DnsLookup;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export class FetchGuardError extends Error {
  readonly code:
    | 'not_https'
    | 'url_credentials'
    | 'invalid_url'
    | 'dns_failure'
    | 'private_address'
    | 'redirect_refused'
    | 'http_status'
    | 'timeout'
    | 'body_too_large'
    | 'not_json';

  constructor(code: FetchGuardError['code'], message: string) {
    super(message);
    this.name = 'FetchGuardError';
    this.code = code;
  }
}

const defaultLookup: DnsLookup = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function ipv4In(ip: number, base: string, prefixBits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0;
  return (ip & mask) === (baseInt & mask);
}

/** True when the address is NOT a public unicast address. */
export function isNonPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const ip = ipv4ToInt(address);
    if (ip === null) return true;
    return (
      ipv4In(ip, '0.0.0.0', 8) || // "this" network / unspecified
      ipv4In(ip, '10.0.0.0', 8) || // RFC1918
      ipv4In(ip, '100.64.0.0', 10) || // CGNAT shared space
      ipv4In(ip, '127.0.0.0', 8) || // loopback
      ipv4In(ip, '169.254.0.0', 16) || // link-local, incl. 169.254.169.254 metadata
      ipv4In(ip, '172.16.0.0', 12) || // RFC1918
      ipv4In(ip, '192.0.0.0', 24) || // IETF protocol assignments
      ipv4In(ip, '192.0.2.0', 24) || // TEST-NET-1 (documentation)
      ipv4In(ip, '192.168.0.0', 16) || // RFC1918
      ipv4In(ip, '198.18.0.0', 15) || // benchmarking
      ipv4In(ip, '198.51.100.0', 24) || // TEST-NET-2
      ipv4In(ip, '203.0.113.0', 24) || // TEST-NET-3
      ipv4In(ip, '224.0.0.0', 4) || // multicast
      ipv4In(ip, '240.0.0.0', 4) // reserved
    );
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isNonPublicAddress(mapped[1]);
    const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const value = parseInt(mappedHex[1], 16) * 65536 + parseInt(mappedHex[2], 16);
      return isNonPublicAddress(
        `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`,
      );
    }
    // Only global unicast (2000::/3) is fetchable. Reject transition
    // mechanisms that can route to private IPv4 destinations and docs.
    const first = parseInt(lower.split(':')[0], 16);
    if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return true;
    if (first === 0x2002) return true; // 6to4
    if (first === 0x2001) {
      const second = parseInt(lower.split(':')[1] || '0', 16);
      if (second === 0 || second === 0x0db8) return true; // Teredo, docs
    }
    return false;
  }
  return true; // Not an IP at all: treat as unsafe.
}

function parseTarget(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchGuardError('invalid_url', 'Not a valid URL.');
  }
  if (url.protocol !== 'https:') {
    throw new FetchGuardError('not_https', `Refusing non-HTTPS URL: ${url.origin}${url.pathname}`);
  }
  if (url.username || url.password) {
    throw new FetchGuardError('url_credentials', 'Refusing URL with embedded credentials.');
  }

  return url;
}

async function readBodyCapped(
  response: IncomingMessage,
  req: ClientRequest,
  maxBodyBytes: number,
): Promise<string> {
  const declared = response.headers['content-length'];
  if (declared !== undefined && Number(declared) > maxBodyBytes) {
    response.destroy();
    req.destroy();
    throw new FetchGuardError(
      'body_too_large',
      `Response declares ${declared} bytes, over the ${maxBodyBytes}-byte cap.`,
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBodyBytes) {
      response.destroy();
      req.destroy();
      throw new FetchGuardError(
        'body_too_large',
        `Response body exceeds the ${maxBodyBytes}-byte cap.`,
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fetch a URL through the guard and parse the body as JSON.
 * Returns the parsed value; throws FetchGuardError on any refusal.
 */
export async function guardedFetchJson(
  rawUrl: string,
  options: GuardedFetchOptions = {},
): Promise<unknown> {
  const requestImpl = options.requestImpl ?? request;
  const lookupImpl = options.lookupImpl ?? defaultLookup;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const url = parseTarget(rawUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    let addresses: string[];
    if (isIP(hostname)) {
      addresses = [hostname];
    } else {
      try {
        addresses = await Promise.race([
          lookupImpl(hostname),
          new Promise<never>((_, reject) => {
            abort.signal.addEventListener('abort', () => reject(new FetchGuardError(
              'timeout', `Fetch of ${url.origin}${url.pathname} timed out after ${timeoutMs}ms.`,
            )), { once: true });
          }),
        ]);
      } catch (error) {
        if (abort.signal.aborted) {
          throw new FetchGuardError('timeout', `Fetch of ${url.origin}${url.pathname} timed out after ${timeoutMs}ms.`);
        }
        throw new FetchGuardError('dns_failure', `DNS resolution failed for ${hostname}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (addresses.length === 0) {
      throw new FetchGuardError('dns_failure', `DNS resolution returned no addresses for ${hostname}.`);
    }
    for (const address of addresses) {
      if (isNonPublicAddress(address)) {
        throw new FetchGuardError('private_address', `Refusing URL: ${hostname} resolves to a non-public address (${address}).`);
      }
    }
    if (abort.signal.aborted) {
      throw new FetchGuardError('timeout', `Fetch of ${url.origin}${url.pathname} timed out after ${timeoutMs}ms.`);
    }
    const pinned = addresses[0];
    const family = isIP(pinned) as 4 | 6;
    const body = await new Promise<string>((resolve, reject) => {
      const req = requestImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        agent: false,
        signal: abort.signal,
        servername: hostname,
        lookup: (_host, lookupOptions, callback) => {
          if (lookupOptions.all) {
            const reply = callback as (
              error: NodeJS.ErrnoException | null,
              records: { address: string; family: 4 | 6 }[],
            ) => void;
            reply(null, [{ address: pinned, family }]);
          } else {
            callback(null, pinned, family);
          }
        },
      }, (response) => {
        const status = response.statusCode;
        if (status !== undefined && status >= 300 && status < 400) {
          response.destroy();
          req.destroy();
          reject(new FetchGuardError('redirect_refused', `HTTP ${status} from ${url.origin}${url.pathname}: redirects are not followed.`));
          return;
        }
        if (status === undefined || status < 200 || status >= 300) {
          response.destroy();
          req.destroy();
          reject(new FetchGuardError('http_status', `HTTP ${status ?? 'unknown'} from ${url.origin}${url.pathname}.`));
          return;
        }
        void readBodyCapped(response, req, maxBodyBytes).then(resolve, reject);
      });
      req.on('error', reject);
      req.end();
    });
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new FetchGuardError('not_json', `Response from ${url.origin}${url.pathname} is not valid JSON.`);
    }
  } catch (err) {
    if (abort.signal.aborted) {
      throw new FetchGuardError('timeout', `Fetch of ${url.origin}${url.pathname} timed out after ${timeoutMs}ms.`);
    }
    if (err instanceof FetchGuardError) throw err;
    throw new FetchGuardError('http_status', `Fetch of ${url.origin}${url.pathname} failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}
