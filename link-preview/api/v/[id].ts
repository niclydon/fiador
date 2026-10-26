// Thin Vercel adapter for /v/<short-id> (DESIGN §6.4 hosting posture).
//
// Portability rule: this file is the ONLY platform coupling for the
// page route. The handler itself (../../src/handler.js) is a
// framework-free Request -> Response function over injected deps, so
// moving to Cloudflare Workers/Pages later is a relocation of this
// adapter, not a rewrite of the surface.
import { handleRequest } from '../../src/handler.js';
import { createDefaultDeps } from '../../src/default-deps.js';

export async function GET(req: Request): Promise<Response> {
  return handleRequest(req, createDefaultDeps());
}

export default GET;
