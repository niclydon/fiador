#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { depsFromEnv } from './config.js';
import { createVerifyMcpServer } from './server.js';

// One tool implementation, two transports (SPEC 11.4). stdio is the
// default for local agent use: stdout is protocol bytes only, all
// diagnostics go to stderr. --http serves streamable HTTP, stateless
// (the tools are read-only and hold no per-client state). The server
// ships no authentication of its own; deployments that want access
// control put it at their gateway.
// SPEC 11.9 M1 (undecided): no project-run public HTTP instance in
// v1 — this transport exists for self-hosters, behind configuration.
const deps = depsFromEnv();

if (process.argv.includes('--http')) {
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const port = Number(
    portArg?.slice('--port='.length) ?? process.env.VERIFY_MCP_PORT ?? 8787,
  );

  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.url !== '/mcp') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        let body: unknown;
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const text = Buffer.concat(chunks).toString('utf8');
          body = text.length > 0 ? JSON.parse(text) : undefined;
        }
        // Stateless mode (SDK pattern): a fresh server + transport per
        // request. Reusing one transport across requests makes the SDK
        // reject follow-up requests with a 500.
        const requestServer = createVerifyMcpServer(deps);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await requestServer.connect(transport);
        await transport.handleRequest(req, res, body);
        res.on('close', () => {
          void transport.close();
          void requestServer.close();
        });
      } catch (err) {
        console.error('[verify-mcp] request failed:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal error' }));
        }
      }
    },
  );
  httpServer.listen(port, () => {
    console.error(`[verify-mcp] streamable HTTP on :${port} (POST /mcp)`);
  });
} else {
  const server = createVerifyMcpServer(deps);
  await server.connect(new StdioServerTransport());
  console.error('[verify-mcp] stdio transport ready');
}
