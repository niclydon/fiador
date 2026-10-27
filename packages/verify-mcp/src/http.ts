import { createServer, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ConfigError } from './config.js';
import { createVerifyMcpServer, type VerifyMcpDeps } from './server.js';

// The streamable-HTTP wiring (SPEC 11.4), extracted from main.ts so
// the integration tests exercise the REAL handler — routing, body
// handling, and error paths — not a re-implementation of it (7.5
// review B4).
//
// Body discipline (7.5 re-review B4): this handler NEVER reads or
// buffers the request body. The raw request goes to the SDK
// transport, which reads it itself under the maxRequestBodySize
// cap passed below — the transport counts the bytes it actually
// reads, so chunked bodies are capped exactly like declared ones,
// and every oversize rejection comes out in the SDK's own error
// shape on both paths. There is deliberately no hand-rolled
// pre-check: two cap implementations that can disagree are a
// finding, not a defence. Arrival time is bounded by the factory's
// own per-request timers (see createVerifyHttpServer): a
// headers deadline below a TOTAL request deadline — total meaning
// measured from when the request began arriving, never reset by
// arriving bytes, so a slow drip cannot hold a request open past
// it.
export const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

// Host normalisation for loopback recognition (7.5 re-review M15).
// The DNS-rebinding membership test and the operator warning in
// main.ts must agree on what "loopback" means, and operator input
// arrives in every spelling: 'LOCALHOST', 'localhost.', '127.1',
// '127.0.1', '2130706433', '0x7f.1', '0:0:0:0:0:0:0:1',
// '::ffff:127.0.0.1'. Normalisation follows inet_aton / WHATWG URL
// host parsing: IPv4 numbers may be decimal, hex, or octal, with
// 1–4 parts (missing parts widen the last one); IPv6 may be
// compressed and may embed an IPv4 tail. Anything unparseable is
// NOT loopback (fail closed: rebinding protection stays off only
// for hosts positively recognised, and the warning fires).
function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length > 4 || parts.some((p) => p.length === 0)) return null;
  const nums: number[] = [];
  for (const part of parts) {
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(part)) n = parseInt(part, 16);
    else if (/^0[0-7]+$/.test(part)) n = parseInt(part, 8);
    else if (/^(0|[1-9][0-9]*)$/.test(part)) n = parseInt(part, 10);
    else return null;
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  const last = nums[nums.length - 1]!;
  const lastMax = 256 ** (5 - nums.length) - 1;
  if (last > lastMax) return null;
  for (let i = 0; i < nums.length - 1; i += 1) {
    if (nums[i]! > 255) return null;
  }
  const value =
    nums.slice(0, -1).reduce((acc, n, i) => acc + n * 256 ** (3 - i), 0) +
    last;
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256);
}

function parseIpv6(host: string): number[] | null {
  let h = host;
  let v4Tail: number[] | null = null;
  if (h.includes('.')) {
    const idx = h.lastIndexOf(':');
    if (idx < 0) return null;
    v4Tail = parseIpv4(h.slice(idx + 1));
    if (v4Tail === null) return null;
    h = `${h.slice(0, idx)}:0:0`;
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const out: number[] = [];
    for (const group of side.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const left = parseSide(halves[0]!);
  if (left === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const right = parseSide(halves[1]!);
    if (right === null) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  } else {
    if (left.length !== 8) return null;
    groups = left;
  }
  if (v4Tail !== null) {
    groups[6] = v4Tail[0]! * 256 + v4Tail[1]!;
    groups[7] = v4Tail[2]! * 256 + v4Tail[3]!;
  }
  return groups;
}

// The canonical form of a bind host for comparison: 'localhost'
// for the name, dotted-quad for IPv4, the expanded group list for
// IPv6, or null when the host is not an IP/name we can reason
// about.
export function normalizeHost(host: string): string | null {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h === 'localhost.') return 'localhost';
  const v4 = parseIpv4(h);
  if (v4 !== null) return v4.join('.');
  if (h.includes(':')) {
    const v6 = parseIpv6(h);
    if (v6 !== null) return v6.join(':');
  }
  return null;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  if (normalized === null) return false;
  if (normalized === 'localhost') return true;
  if (normalized.includes(':')) {
    const groups = normalized.split(':').map(Number);
    const isV6Loopback = groups.every((g, i) => g === (i === 7 ? 1 : 0));
    // ::ffff:a.b.c.d — an IPv4-mapped loopback is loopback.
    const isMappedLoopback =
      groups.slice(0, 5).every((g) => g === 0) &&
      groups[5] === 0xffff &&
      Math.floor(groups[6]! / 256) === 127;
    return isV6Loopback || isMappedLoopback;
  }
  return normalized.split('.')[0] === '127';
}

export interface HttpOptions {
  host: string;
  port: number;
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
}

// Strict numeric config (7.5 review M16): an explicitly-set invalid
// port is a startup error naming its source, never a silent default;
// port 0 (an ephemeral bind a deployment cannot advertise) is
// rejected like any other out-of-range value. Both the '--port=N'
// and the '--port N' spellings are accepted (fix pass 2, M16).
export function parseHttpOptions(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): HttpOptions {
  const host = env.VERIFY_MCP_HOST ?? '127.0.0.1';
  if (host.length === 0) {
    throw new ConfigError('VERIFY_MCP_HOST must be a host name or IP address');
  }
  const eqArg = argv.find((a) => a.startsWith('--port='));
  const spaceIdx = argv.indexOf('--port');
  let raw: string;
  let source: string;
  if (eqArg !== undefined) {
    raw = eqArg.slice('--port='.length);
    source = '--port';
  } else if (spaceIdx >= 0) {
    const value = argv[spaceIdx + 1];
    if (value === undefined) {
      throw new ConfigError('--port must be an integer between 1 and 65535');
    }
    raw = value;
    source = '--port';
  } else {
    raw = env.VERIFY_MCP_PORT ?? '8787';
    source = 'VERIFY_MCP_PORT';
  }
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${source} must be an integer between 1 and 65535`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new ConfigError(`${source} must be an integer between 1 and 65535`);
  }
  return { host, port };
}

function methodNotAllowed(res: import('node:http').ServerResponse, allow: string): void {
  // The SDK's own unsupported-method shape (7.5 re-review m7): a
  // JSON-RPC error body, not a bespoke REST one, so clients see one
  // dialect from this endpoint.
  res.writeHead(405, { 'content-type': 'application/json', allow });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    }),
  );
}

export function createVerifyHttpServer(deps: VerifyMcpDeps, options: HttpOptions): Server {
  // The factory validates its own options (7.5 re-review M16): a
  // programmatic caller gets the same ConfigError discipline as
  // the CLI parser, instead of a silently broken bind. Port 0 is
  // allowed HERE — an ephemeral bind is a legitimate test/tooling
  // use of the factory; parseHttpOptions remains the deployment
  // gate that rejects it.
  if (typeof options.host !== 'string' || options.host.trim().length === 0) {
    throw new ConfigError('host must be a non-empty host name or IP address');
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new ConfigError('port must be an integer between 0 and 65535');
  }
  const headersTimeoutMs = options.headersTimeoutMs ?? HEADERS_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  if (
    !(
      Number.isFinite(headersTimeoutMs) &&
      Number.isFinite(requestTimeoutMs) &&
      headersTimeoutMs > 0 &&
      headersTimeoutMs < requestTimeoutMs
    )
  ) {
    throw new ConfigError('headersTimeoutMs must be positive and below requestTimeoutMs');
  }
  const loopback = isLoopbackHost(options.host);
  const server = createServer(async (req, res) => {
    try {
      // Route on the pathname, never the verbatim URL (7.5 review
      // m7): a query string must not turn /health into a 404 or /mcp
      // into a different route.
      const { pathname } = new URL(req.url ?? '/', 'http://verify-mcp.local');
      if (pathname === '/health') {
        if (req.method !== 'GET') {
          methodNotAllowed(res, 'GET');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (pathname !== '/mcp') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      if (req.method !== 'POST') {
        // Method gating in front of the transport (7.5 re-review
        // m7): the stateless transport would otherwise answer a
        // DELETE with a bare 200. Only POST carries JSON-RPC here.
        methodNotAllowed(res, 'POST');
        return;
      }
      // Stateless mode (SDK pattern): a fresh server + transport per
      // request. Reusing one transport across requests makes the SDK
      // reject follow-up requests with a 500.
      const bound = server.address();
      const actualPort =
        bound !== null && typeof bound === 'object' ? bound.port : options.port;
      const hostForms = new Set<string>([
        options.host,
        `${options.host}:${actualPort}`,
      ]);
      const normalized = normalizeHost(options.host);
      if (normalized !== null) {
        hostForms.add(normalized);
        hostForms.add(`${normalized}:${actualPort}`);
      }
      const allowedHosts = [
        ...hostForms,
        `127.0.0.1:${actualPort}`,
        `localhost:${actualPort}`,
        `[::1]:${actualPort}`,
        '127.0.0.1',
        'localhost',
        '[::1]',
      ];
      const requestServer = createVerifyMcpServer(deps);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // The body cap lives in the transport (fix pass 2, B4).
        maxRequestBodySize: MAX_HTTP_BODY_BYTES,
        // DNS-rebinding protection for loopback binds (7.5 review
        // M15): without it, any website a local user visits can POST
        // to a loopback MCP server. Non-loopback binds are the
        // operator's explicit choice (VERIFY_MCP_HOST) and are
        // documented as exposed in the README.
        ...(loopback
          ? { enableDnsRebindingProtection: true, allowedHosts }
          : {}),
      });
      await requestServer.connect(transport);
      await transport.handleRequest(req, res);
      res.on('close', () => {
        void transport.close();
        void requestServer.close();
      });
    } catch {
      // Fixed message only (7.5 review M12): the underlying error —
      // which may echo request material — is never sent to the caller
      // and never logged with its payload. The response is always
      // ended or destroyed; a hung socket is a finding, not a style.
      console.error('[verify-mcp] request failed');
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal error' }));
        } else if (!res.writableEnded) {
          res.destroy();
        }
      } catch {
        // The socket is already gone; nothing left to close.
      }
    }
  });
  // Arrival deadlines, enforced by the factory's own timers.
  // Probing the pinned Node (v22) showed the built-in
  // headersTimeout / requestTimeout properties do NOT terminate
  // an idle connection, a header drip, or a body drip in this
  // build (only the legacy per-gap inactivity timeout fires, and
  // a per-gap timer is exactly what a drip defeats). So the
  // bounds are enforced here, PER REQUEST (the per-connection
  // version was 7.5 re-review 2's NEW-1): the headers timer was
  // armed once at connect and cleared at the first request
  // event, so on a reused (keep-alive) connection the second
  // request's header phase was bounded by nothing, and its
  // total deadline started only once its headers had fully
  // arrived — a drip there held the connection indefinitely.
  // The state machine below re-arms for every request: the
  // headers deadline covers the phase from when a request may
  // begin arriving (the connection, or the previous response's
  // completion) to its request event, and the total deadline is
  // measured from that same start — a total that arriving bytes
  // never reset. The built-ins are also assigned, as defence in
  // depth for runtimes that honour them, with the same values.
  server.headersTimeout = headersTimeoutMs;
  server.requestTimeout = requestTimeoutMs;
  interface SocketState {
    startedAt: number; // when the current request began arriving
    headerTimer?: NodeJS.Timeout;
    totalTimer?: NodeJS.Timeout;
    inFlight: number;
  }
  const sockets = new Map<import('node:net').Socket, SocketState>();
  const armHeaders = (socket: import('node:net').Socket, state: SocketState): void => {
    if (state.headerTimer) clearTimeout(state.headerTimer);
    state.startedAt = Date.now();
    state.headerTimer = setTimeout(() => socket.destroy(), headersTimeoutMs);
  };
  server.on('connection', (socket) => {
    const state: SocketState = { startedAt: Date.now(), inFlight: 0 };
    sockets.set(socket, state);
    armHeaders(socket, state);
    socket.once('close', () => {
      if (state.headerTimer) clearTimeout(state.headerTimer);
      if (state.totalTimer) clearTimeout(state.totalTimer);
      sockets.delete(socket);
    });
  });
  server.on('request', (req, res) => {
    const state = sockets.get(req.socket);
    if (!state) return;
    if (state.headerTimer) {
      clearTimeout(state.headerTimer);
      state.headerTimer = undefined;
    }
    state.inFlight += 1;
    const remaining = Math.max(0, requestTimeoutMs - (Date.now() - state.startedAt));
    if (state.totalTimer) clearTimeout(state.totalTimer);
    state.totalTimer = setTimeout(() => {
      req.destroy();
      res.destroy();
    }, remaining);
    res.once('close', () => {
      state.inFlight -= 1;
      if (state.inFlight > 0) return; // a pipelined request still owns the socket
      state.inFlight = 0;
      if (state.totalTimer) {
        clearTimeout(state.totalTimer);
        state.totalTimer = undefined;
      }
      // The socket is idle, waiting for the next request: that
      // request's header phase gets a fresh deadline (NEW-1).
      if (!req.socket.destroyed) armHeaders(req.socket, state);
    });
  });
  return server;
}
