/**
 * FlareHub Worker entry point.
 *
 * Routes requests to:
 * - Static assets (frontend panel) via ASSETS binding
 * - Docker Registry proxy (/v2 and /token)
 * - GitHub / HF / Docker binary proxy (everything else)
 *
 * Rate limiting is applied only to proxy requests (registry + github),
 * not to static assets, to minimize subrequest overhead.
 */

import { proxyGithub } from './github.js';
import { proxyRegistry } from './registry.js';
import { errorResponse, corsPreflight } from './http.js';

/** Set of all known upstream hosts for fast lookup. */
const KNOWN_HOSTS = new Set([
  'github.com', 'raw.githubusercontent.com', 'api.github.com',
  'codeload.github.com', 'github.githubassets.com',
  'gist.github.com', 'gist.githubusercontent.com',
  'objects.githubusercontent.com', 'github-releases.githubusercontent.com',
  'huggingface.co', 'cdn-lfs.hf.co', 'cdn-lfs-us-1.hf.co',
  'download.docker.com',
  'gitlab.com',
]);

/** Determine if a path belongs to the Docker Registry v2 protocol. */
function isRegistryPath(pathname) {
  return pathname === '/v2' || pathname.startsWith('/v2/') || pathname === '/token';
}

/**
 * Determine if a path is a proxy request (not static assets or API).
 * Note: Registry paths are checked separately before this function.
 */
function isProxyPath(pathname) {
  const firstSeg = pathname.slice(1).split('/')[0];
  if (KNOWN_HOSTS.has(firstSeg)) return true;
  // Cloudflare encodes : in /https:// to %3A in production
  if (pathname.startsWith('/https://')) return true;
  if (pathname.startsWith('/https%3A/') || pathname.startsWith('/https%3a/')) return true;
  return false;
}

/**
 * Apply rate limiting to proxy requests only.
 * Returns null if allowed, or a 429 Response if limited.
 */
async function checkRateLimit(request, env) {
  if (!env.RATE_LIMITER) return null;
  try {
    const { success } = await env.RATE_LIMITER.limit({
      key: request.headers.get('cf-connecting-ip') || 'anonymous',
    });
    if (!success) {
      return errorResponse(429, 'Rate limit exceeded');
    }
  } catch {
    // Rate limiter unavailable, proceed without limiting
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // OPTIONS preflight (no rate limiting for static CORS)
    if (request.method === 'OPTIONS') {
      return corsPreflight();
    }

    // Root path → static index (frontend panel)
    if (pathname === '/' || pathname === '') {
      if (!env.ASSETS) return errorResponse(404, 'Frontend not deployed');
      return env.ASSETS.fetch(new Request(new URL('/', url.origin), request));
    }

    // Registry proxy: /v2 and /token
    if (isRegistryPath(pathname)) {
      const limited = await checkRateLimit(request, env);
      if (limited) return limited;
      return proxyRegistry(request, env, ctx);
    }

    // GitHub/HF/Docker binary proxy
    if (isProxyPath(pathname)) {
      const limited = await checkRateLimit(request, env);
      if (limited) return limited;
      return proxyGithub(request, env);
    }

    // Everything else → static assets
    if (!env.ASSETS) return errorResponse(404, 'Not found');
    return env.ASSETS.fetch(request);
  },
};
