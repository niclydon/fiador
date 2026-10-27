#!/usr/bin/env node
import { depsFromEnv, portFromEnv } from './config.js';
import { createBadgeService } from './service.js';

// One process, no database, no keys (SPEC 4.8). Diagnostics go to
// stderr; stdout carries nothing but the listen line.
const port = portFromEnv();
const server = createBadgeService(depsFromEnv());
server.listen(port, () => {
  console.error(`[badge-service] listening on :${port}`);
});
