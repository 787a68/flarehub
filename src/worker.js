/**
 * FlareHub Worker entry point.
 *
 * Routes requests to:
 * - Static assets (frontend panel) via ASSETS binding
 * - Docker Registry proxy (/v2, /token, /<host>/v2, /<host>/token)
 * - GitHub / HF / Docker binary proxy (everything else)
 *
 * Rate limiting is applied globally to ALL requests (including OPTIONS).
 */

import { proxyGithub } from './github.js';
import { proxyRegistry } from './registry.js';
import { errorResponse, corsPreflight } from './http.js';

/** Registry hosts that appear as path prefix. */
const REGISTRY_HOSTS = new Set([
  'ghcr.io', 'quay.io', 'gcr.io', 'registry.k8s.io',
]);

/** Set of all known upstream hosts for fast lookup. */
const KNOWN_HOSTS = new Set([
  'github.com', 'raw.githubusercontent.com', 'api.github.com',
  'codeload.github.com', 'github.githubassets.com',
  'gist.github.com', 'gist.githubusercontent.com',
  'huggingface.co', 'cdn-lfs.hf.co', 'cdn-lfs-us-1.hf.co',
  'download.docker.com',
  'registry-1.docker.io', 'ghcr.io', 'quay.io', 'gcr.io', 'registry.k8s.io',
]);

/**
 * Determine if a path is a registry proxy request.
 * /v2/..., /token, /<host>/v2/..., /<host>/token
 */
function isRegistryPath(pathname) {
  if (pathname.startsWith('/v2/') || pathname === '/token') return true;
  for (const host of REGISTRY_HOSTS) {
    if (pathname.startsWith(`/${host}/v2/`) || pathname === `/${host}/token`) return true;
  }
  return false;
}

/**
 * Determine if a path is a proxy request (not static assets or API).
 */
function isProxyPath(pathname) {
  if (isRegistryPath(pathname)) return true;
  const firstSeg = pathname.slice(1).split('/')[0];
  if (KNOWN_HOSTS.has(firstSeg)) return true;
  if (pathname.startsWith('/https://')) return true;
  return false;
}

/**
 * Apply global rate limiting to all requests.
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
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Log request URL for debugging (visible in wrangler tail / dashboard)
    console.log(`${request.method} ${url.pathname}${url.search}`);

    // Global rate limiting for ALL requests (including OPTIONS)
    const limited = await checkRateLimit(request, env);
    if (limited) return limited;

    // OPTIONS preflight (after rate limiting)
    if (request.method === 'OPTIONS') {
      return corsPreflight();
    }

    // Root path → static index (frontend panel)
    if (pathname === '/' || pathname === '') {
      if (!env.ASSETS) return errorResponse(404, 'Frontend not deployed');
      return env.ASSETS.fetch(new Request(new URL('/', url.origin), request));
    }

    // Proxy requests: registry or GitHub/HF/Docker
    if (isProxyPath(pathname)) {
      if (isRegistryPath(pathname)) {
        return proxyRegistry(request, env);
      }
      return proxyGithub(request, env);
    }

    // Everything else → static assets
    if (!env.ASSETS) return errorResponse(404, 'Not found');
    return env.ASSETS.fetch(request);
  },
};
