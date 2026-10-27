#!/usr/bin/env node
import { ConfigError, depsFromEnv, hostFromEnv, isLoopbackHost, portFromEnv } from './config.js';
import { createBadgeService } from './service.js';

// One process, no database, no keys (SPEC 4.8). Diagnostics go to
// stderr; stdout carries nothing but the listen line. Startup
// configuration failures print one sanitised fixed line (the
// ConfigError message names the variable and the problem class
// only) and exit non-zero — never a raw stack.
let server;
try {
  const port = portFromEnv();
  const host = hostFromEnv();
  server = createBadgeService(depsFromEnv());
  if (!isLoopbackHost(host)) {
    console.error(
      `[badge-service] warning: binding ${host} — this service is unauthenticated by design; ` +
        'a non-loopback bind is an exposure decision (SPEC 4.7). Set BADGE_HOST=127.0.0.1 to stay loopback.',
    );
  }
  server.listen(port, host, () => {
    console.error(`[badge-service] listening on ${host}:${port}`);
  });
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[badge-service] startup error: ${err.message}`);
  } else {
    console.error('[badge-service] startup error: configuration could not be loaded');
  }
  process.exit(1);
}
