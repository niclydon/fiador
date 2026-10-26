// Thin Vercel adapter for /v/<short-id>/card[.svg] — the og:image
// target. Same portability rule as ../[id].ts: platform coupling lives
// here only; the verdict logic is the shared handler.
import { handleRequest } from '../../../src/handler.js';
import { createDefaultDeps } from '../../../src/default-deps.js';

export async function GET(req: Request): Promise<Response> {
  return handleRequest(req, createDefaultDeps());
}

export default GET;
