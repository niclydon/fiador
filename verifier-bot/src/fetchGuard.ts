// SSRF-guarded fetcher for operator-influenced URLs (DESIGN §5.4).
//
// Every URL the bot fetches because an operator or a registry pointed at
// it goes through here. The guard, in order:
//   1. HTTPS only. No credentials in the URL.
//   2. The hostname is resolved first; if ANY resolved address is
//      loopback, RFC1918, link-local (incl. the cloud metadata range),
//      unique-local, or otherwise non-public, the fetch is refused.
//      Literal IP hosts are checked directly, without resolution.
//   3. No redirect following (DESIGN §5.4): a 3xx is a failed fetch,
//      because the redirect target was never vetted. Operators host
//      the attestation at its final URL.
//   4. 5s timeout per request; 64 KiB body cap, enforced while reading.
//   5. The body must parse as JSON; a JSON content type is expected
//      but not required (the parse attempt decides, per §5.4).
//
// Both the fetch implementation and the DNS lookup are injectable so the
// guard is fully testable without network access.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const MAX_BODY_BYTES = 64 * 1024;
export const FETCH_TIMEOUT_MS = 5000;

export type DnsLookup = (hostname: string) => Promise<string[]>;

export interface GuardedFetchOptions {
  fetchImpl?: typeof fetch;
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
    if (lower === '::' || lower === '::1') return true; // unspecified / loopback
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb'))
      return true; // fe80::/10 link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique-local
    if (lower.startsWith('ff')) return true; // multicast
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isNonPublicAddress(mapped[1]);
    return false;
  }
  return true; // Not an IP at all: treat as unsafe.
}

async function assertUrlIsFetchable(rawUrl: string, lookupImpl: DnsLookup): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchGuardError('invalid_url', `Not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'https:') {
    throw new FetchGuardError('not_https', `Refusing non-HTTPS URL: ${url.origin}${url.pathname}`);
  }
  if (url.username || url.password) {
    throw new FetchGuardError('url_credentials', 'Refusing URL with embedded credentials.');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    if (isNonPublicAddress(hostname)) {
      throw new FetchGuardError(
        'private_address',
        `Refusing URL whose host is a non-public address: ${hostname}`,
      );
    }
    return url;
  }

  let addresses: string[];
  try {
    addresses = await lookupImpl(hostname);
  } catch (err) {
    throw new FetchGuardError(
      'dns_failure',
      `DNS resolution failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (addresses.length === 0) {
    throw new FetchGuardError('dns_failure', `DNS resolution returned no addresses for ${hostname}.`);
  }
  for (const address of addresses) {
    if (isNonPublicAddress(address)) {
      throw new FetchGuardError(
        'private_address',
        `Refusing URL: ${hostname} resolves to a non-public address (${address}).`,
      );
    }
  }
  return url;
}

async function readBodyCapped(response: Response, maxBodyBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBodyBytes) {
    throw new FetchGuardError(
      'body_too_large',
      `Response declares ${declared} bytes, over the ${maxBodyBytes}-byte cap.`,
    );
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBodyBytes) {
      throw new FetchGuardError('body_too_large', `Response body exceeds the ${maxBodyBytes}-byte cap.`);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel().catch(() => undefined);
        throw new FetchGuardError(
          'body_too_large',
          `Response body exceeds the ${maxBodyBytes}-byte cap.`,
        );
      }
      chunks.push(value);
    }
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
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookupImpl = options.lookupImpl ?? defaultLookup;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;

  const url = await assertUrlIsFetchable(rawUrl, lookupImpl);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new FetchGuardError('timeout', `Fetch of ${url.origin}${url.pathname} timed out after ${timeoutMs}ms.`);
    }
    throw new FetchGuardError(
      'http_status',
      `Fetch of ${url.origin}${url.pathname} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (response.status >= 300 && response.status < 400) {
    // §5.4: no redirect following. The redirect target was never vetted;
    // operators host the attestation at its final URL.
    throw new FetchGuardError(
      'redirect_refused',
      `HTTP ${response.status} from ${url.origin}${url.pathname}: redirects are not followed.`,
    );
  }

  if (!response.ok) {
    throw new FetchGuardError('http_status', `HTTP ${response.status} from ${url.origin}${url.pathname}.`);
  }

  const text = await readBodyCapped(response, maxBodyBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FetchGuardError('not_json', `Response from ${url.origin}${url.pathname} is not valid JSON.`);
  }
}
