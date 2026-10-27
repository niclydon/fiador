import { createServer, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ConfigError } from './config.js';
import { createVerifyMcpServer, type VerifyMcpDeps } from './server.js';

// The streamable-HTTP wiring (SPEC 11.4), extracted from main.ts so
// the integration tests exercise the REAL handler — routing, body
// handling, and error paths — not a re-implementation of it (7.5
// review B4).
//
// Body discipline: this handler NEVER reads or buffers the request
// body. The raw request goes to the SDK transport, which reads it
// itself. Two guards stand in front of that hand-off: a declared
// Content-Length above MAX_HTTP_BODY_BYTES is refused with 413
// before any byte is read, and the server's requestTimeout bounds
// how long any body may take to arrive. (The SDK's Node transport
// applies no application-level cap of its own in 1.32.x; these two
// guards are the cap, and this comment is the record of that.)
export const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface HttpOptions {
  host: string;
  port: number;
}

// Strict numeric config (7.5 review M16): an explicitly-set invalid
// port is a startup error naming its source, never a silent default;
// port 0 (an ephemeral bind a deployment cannot advertise) is
// rejected like any other out-of-range value.
export function parseHttpOptions(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): HttpOptions {
  const host = env.VERIFY_MCP_HOST ?? '127.0.0.1';
  if (host.length === 0) {
    throw new ConfigError('VERIFY_MCP_HOST must be a host name or IP address');
  }
  const portArg = argv.find((a) => a.startsWith('--port='));
  const raw = portArg !== undefined
    ? portArg.slice('--port='.length)
    : (env.VERIFY_MCP_PORT ?? '8787');
  const source = portArg !== undefined ? '--port' : 'VERIFY_MCP_PORT';
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${source} must be an integer between 1 and 65535`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new ConfigError(`${source} must be an integer between 1 and 65535`);
  }
  return { host, port };
}

export function createVerifyHttpServer(deps: VerifyMcpDeps, options: HttpOptions): Server {
  const loopback = LOOPBACK_HOSTS.has(options.host);
  const server = createServer(async (req, res) => {
    try {
      // Route on the pathname, never the verbatim URL (7.5 review
      // m7): a query string must not turn /health into a 404 or /mcp
      // into a different route.
      const { pathname } = new URL(req.url ?? '/', 'http://verify-mcp.local');
      if (pathname === '/health') {
        if (req.method !== 'GET') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
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
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_HTTP_BODY_BYTES) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'request body too large' }));
        req.destroy();
        return;
      }
      // Stateless mode (SDK pattern): a fresh server + transport per
      // request. Reusing one transport across requests makes the SDK
      // reject follow-up requests with a 500.
      const bound = server.address();
      const actualPort =
        bound !== null && typeof bound === 'object' ? bound.port : options.port;
      const allowedHosts = [
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
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}
