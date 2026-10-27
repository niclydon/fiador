#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, depsFromEnv } from './config.js';
import { createVerifyHttpServer, parseHttpOptions } from './http.js';
import { createVerifyMcpServer } from './server.js';

// One tool implementation, two transports (SPEC 11.4). stdio is the
// default for local agent use: stdout is protocol bytes only, all
// diagnostics go to stderr. --http serves streamable HTTP, stateless
// (the tools are read-only and hold no per-client state), bound to
// loopback unless VERIFY_MCP_HOST says otherwise. The server ships
// no authentication of its own; deployments that want access
// control put it at their gateway.
// SPEC 11.9 M1 (DECIDED, Nic, Oct 26, 2026): no project-run public
// HTTP instance in v1. This transport exists for self-hosters;
// discovery is via the MCP registry listings, and the program
// operates no public endpoint for this server.
//
// Startup failures exit with the fixed configuration message only
// (7.5 review M14): config errors are sanitised at their source in
// config.ts, and anything unexpected collapses to a generic line.

function startup<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    console.error(
      `[verify-mcp] startup failed: ${err instanceof ConfigError ? err.message : 'invalid configuration'}`,
    );
    process.exit(1);
  }
}

const deps = startup(() => depsFromEnv());

if (process.argv.includes('--http')) {
  const options = startup(() => parseHttpOptions());
  const httpServer = createVerifyHttpServer(deps, options);
  httpServer.listen(options.port, options.host, () => {
    console.error(
      `[verify-mcp] streamable HTTP on ${options.host}:${options.port} (POST /mcp)`,
    );
    if (options.host !== '127.0.0.1' && options.host !== 'localhost' && options.host !== '::1') {
      console.error(
        '[verify-mcp] WARNING: bound to a non-loopback address with no built-in authentication; ' +
          'anyone who can reach this port can call the tools. Put access control at a gateway.',
      );
    }
  });
} else {
  const server = createVerifyMcpServer(deps);
  await server.connect(new StdioServerTransport());
  console.error('[verify-mcp] stdio transport ready');
}
