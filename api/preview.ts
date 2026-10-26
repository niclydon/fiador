// The only host-specific bridge for the public /v/ routes. The verdict
// handler remains a framework-free Request -> Response function.
import registry from '../registry/registry.json' with { type: 'json' };
import { createDefaultDeps } from '../link-preview/src/default-deps.js';
import type { LinkPreviewDeps } from '../link-preview/src/deps.js';
import { handleRequest } from '../link-preview/src/handler.js';

function baseUrl(): string {
  // A protected preview must send its click-through to that same preview.
  if (process.env.VERCEL_ENV === 'preview') {
    if (!process.env.VERCEL_URL) {
      throw new Error('VERCEL_URL is required for a Fiador preview.');
    }
    return `https://${process.env.VERCEL_URL}`;
  }
  return process.env.FIADOR_BASE_URL ?? 'https://fiador.org';
}

export async function handlePreviewRequest(
  req: Request,
  injectedDeps?: LinkPreviewDeps,
): Promise<Response> {
  const incoming = new URL(req.url);
  const id = incoming.searchParams.get('fiador_id');
  const card = incoming.searchParams.get('fiador_card') === '1';
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return new Response('not found', { status: 404 });
  }

  const origin = baseUrl();
  const route = new URL(`/v/${id}${card ? '/card.svg' : ''}`, origin);
  const request = new Request(route, { method: req.method, headers: req.headers });
  const deps = injectedDeps ?? createDefaultDeps({ baseUrl: origin });
  // Vercel Deployment Protection can block a function's HTTP self-fetch.
  // Read the bundled canonical source that is also copied to /registry.json.
  return handleRequest(request, {
    ...deps,
    baseUrl: origin,
    registrySource: async () => registry,
  });
}

export async function GET(req: Request): Promise<Response> {
  return handlePreviewRequest(req);
}

export default { fetch: GET };
