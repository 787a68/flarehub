/**
 * Docker Registry v2 proxy.
 *
 * Supports:
 * - Docker Hub (registry-1.docker.io)
 * - GitHub Container Registry (ghcr.io)
 * - Quay.io (quay.io)
 * - Google Container Registry (gcr.io)
 * - Kubernetes registry (registry.k8s.io)
 *
 * Handles auth token relay via /token endpoint and rewrites
 * www-authenticate challenges to point through the proxy.
 */

import { errorResponse, sanitizeHeaders, sanitizeRequestHeaders, withCors } from './http.js';
import { checkAccess } from './access.js';

/** Registry host → upstream base URL. */
export const REGISTRIES = {
  'registry-1.docker.io': 'https://registry-1.docker.io',
  'ghcr.io': 'https://ghcr.io',
  'quay.io': 'https://quay.io',
  'gcr.io': 'https://gcr.io',
  'registry.k8s.io': 'https://registry.k8s.io',
};

/** Auth endpoints for each registry. */
const AUTH_ENDPOINTS = {
  'registry-1.docker.io': { base: 'https://auth.docker.io', path: '/token' },
  'ghcr.io': { base: 'https://ghcr.io', path: '/token' },
  'quay.io': { base: 'https://quay.io', path: '/v2/auth' },
  'gcr.io': { base: 'https://gcr.io', path: '/v2/token' },
  'registry.k8s.io': { base: 'https://registry.k8s.io', path: '/v2/auth' },
};

/** Auth service identifiers per registry (from www-authenticate challenges). */
const AUTH_SERVICES = {
  'registry-1.docker.io': 'registry.docker.io',
  'ghcr.io': 'ghcr.io',
  'quay.io': 'quay.io',
  'gcr.io': 'gcr.io',
  'registry.k8s.io': 'registry.k8s.io',
};

/** Reverse map: service identifier → registry host (for /token routing). */
const SERVICE_TO_HOST = Object.fromEntries(
  Object.entries(AUTH_SERVICES).map(([host, svc]) => [svc, host])
);

/** Maximum cache TTL for auth tokens (slightly under typical 300s expires_in). */
const TOKEN_CACHE_TTL = 280;

/**
 * Build a synthetic Cache API URL for a registry auth token.
 * Cache keys are scoped by host + service + scope so that tokens for
 * different repositories don't collide.
 */
function tokenCacheUrl(host, service, scope) {
  const key = `${host}:${service}:${scope || ''}`;
  return `https://flarehub-cache.local/token/${encodeURIComponent(key)}`;
}

/**
 * Retrieve a cached auth token from the Cache API.
 * Returns the Bearer token string, or null on miss / expiry.
 */
async function getCachedToken(host, service, scope) {
  try {
    const cache = caches.default;
    const res = await cache.match(new Request(tokenCacheUrl(host, service, scope)));
    if (!res) return null;
    const data = await res.json();
    if (data?.token && Date.now() < data.expiresAt) return data.token;
  } catch {
    // Cache miss or parse error — proceed without token
  }
  return null;
}

/**
 * Store an auth token in the Cache API for cross-request reuse.
 */
async function setCachedToken(host, service, scope, token, expiresIn) {
  const ttl = Math.min(expiresIn || 300, TOKEN_CACHE_TTL);
  try {
    const cache = caches.default;
    const body = JSON.stringify({ token, expiresAt: Date.now() + ttl * 1000 });
    const res = new Response(body, {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttl}` },
    });
    await cache.put(new Request(tokenCacheUrl(host, service, scope)), res);
  } catch {
    // Cache write failed — proceed without caching
  }
}

/**
 * Remove a stale auth token from the cache (e.g. after upstream 401).
 */
async function deleteCachedToken(host, service, scope) {
  try {
    await caches.default.delete(new Request(tokenCacheUrl(host, service, scope)));
  } catch {
    // Ignore
  }
}

/**
 * Construct the auth scope for a registry path.
 * /v2/                → '' (service-level token, no repository scope)
 * /v2/library/nginx/manifests/latest → 'repository:library/nginx:pull'
 */
function getScopeForPath(path) {
  const name = extractImageName(path);
  return name ? `repository:${name}:pull` : '';
}

/**
 * Parse the incoming path to determine the target registry.
 *
 * When a user runs `docker pull <proxy>/ghcr.io/owner/repo:tag`, the Docker
 * daemon treats the proxy host as the registry and `ghcr.io/owner/repo` as
 * the image name, so it sends:
 *   GET /v2/ghcr.io/owner/repo/manifests/tag
 * We must detect the embedded registry host in the image name and route
 * accordingly. Only when the image name does NOT start with a known
 * registry host do we fall back to Docker Hub.
 *
 * Path formats (all arrive as /v2/... from the Docker daemon):
 * - /v2/                        → Docker Hub base (ping)
 * - /v2/<name>/manifests/...    → Docker Hub (name may embed a registry host)
 * - /v2/ghcr.io/<name>/...      → GHCR (ghcr.io is the embedded host)
 * - /v2/quay.io/<name>/...      → Quay
 * - /v2/registry.k8s.io/<name>/..→ k8s registry
 * - /token?service=...          → auth relay (service selects upstream)
 *
 * @returns {{ host: string, upstream: URL, path: string, isAuth: boolean } | null}
 */
function parseRegistryPath(pathname, search) {
  // Auth token endpoint: /token or /<host>/token
  if (pathname === '/token' || pathname.endsWith('/token')) {
    const hostMatch = pathname.match(/^\/([^/]+)\/token$/);
    let host = hostMatch ? hostMatch[1] : 'registry-1.docker.io';

    // For /token (no host prefix), check the `service` query parameter
    // to route to the correct upstream auth endpoint.
    if (!hostMatch) {
      const params = new URLSearchParams(search);
      const service = params.get('service') || '';
      // Reverse-lookup: find the registry host whose AUTH_SERVICES matches
      if (SERVICE_TO_HOST[service]) host = SERVICE_TO_HOST[service];
    }

    const ep = AUTH_ENDPOINTS[host] || AUTH_ENDPOINTS['registry-1.docker.io'];
    return {
      host,
      upstream: new URL(`${ep.path}${search}`, ep.base),
      path: ep.path,
      isAuth: true,
    };
  }

  // /v2 and /v2/ → Docker Hub base (ping) endpoint
  if (pathname === '/v2' || pathname === '/v2/') {
    return {
      host: 'registry-1.docker.io',
      upstream: new URL('/v2/' + search, 'https://registry-1.docker.io'),
      path: '/v2/',
      isAuth: false,
    };
  }

  // /v2/... → registry request. The image name may embed a registry host
  // (e.g. /v2/ghcr.io/owner/repo/manifests/tag). Detect it first.
  if (pathname.startsWith('/v2/')) {
    const rest = pathname.slice(4); // strip "/v2/"
    // Check if the first path segment is a known registry host.
    // e.g. "ghcr.io/kyverno/kyverno/manifests/v1.14.0" → host="ghcr.io"
    const slashIdx = rest.indexOf('/');
    const firstSeg = slashIdx === -1 ? rest : rest.slice(0, slashIdx);

    if (REGISTRIES[firstSeg]) {
      // Non-Docker Hub registry: route to the embedded host.
      // Strip the embedded host prefix from the image name so the upstream
      // path is /v2/<name-without-host>/... (e.g. /v2/kyverno/kyverno/...).
      const nameWithoutHost = slashIdx === -1 ? '' : rest.slice(slashIdx + 1);
      const upstreamPath = `/v2/${nameWithoutHost}`;
      return {
        host: firstSeg,
        upstream: new URL(upstreamPath + search, REGISTRIES[firstSeg]),
        path: upstreamPath,
        isAuth: false,
      };
    }

    // Docker Hub: rewrite single-component names to library/<name>.
    // The Docker daemon only adds the `library/` prefix for docker.io,
    // not for third-party registries, so we do it here.
    let rewrittenPath = pathname;
    const m = pathname.match(/^\/v2\/([^/]+)\/(manifests|blobs|tags)/);
    if (m) {
      rewrittenPath = `/v2/library/${m[1]}/${m[2]}${pathname.slice(m[0].length)}`;
    }
    return {
      host: 'registry-1.docker.io',
      upstream: new URL(rewrittenPath + search, 'https://registry-1.docker.io'),
      path: rewrittenPath,
      isAuth: false,
    };
  }

  return null;
}

/**
 * Extract the image name from a registry path for access control.
 * /v2/library/nginx/manifests/latest → library/nginx
 * /v2/myorg/myrepo/blobs/sha256:... → myorg/myrepo
 */
function extractImageName(path) {
  // /v2/<name>/manifests/<reference>
  // /v2/<name>/blobs/<digest>
  // /v2/<name>/tags/list
  const m = path.match(/^\/v2\/(.+?)\/(manifests|blobs|tags)/);
  if (!m) return null;
  return m[1];
}

/**
 * Relay the auth token request to the upstream auth service.
 * On success, cache the token for cross-request reuse to reduce
 * 401 round-trips and Docker Hub rate-limit consumption.
 */
async function handleAuth(upstream, request, host, env) {
  const reqHeaders = sanitizeRequestHeaders(request.headers);

  // Check if the client provided credentials (e.g. docker login to docker.io
  // with registry-mirrors configured). These tokens are per-user and must
  // NOT be cached — otherwise one user's authenticated token could leak
  // to anonymous users.
  const hasClientAuth = reqHeaders.has('authorization');

  // Optionally inject a global PAT to upgrade anonymous rate limits.
  // Only inject when the client didn't provide their own credentials.
  let injectedPAT = false;
  if (!hasClientAuth && env?.DOCKER_HUB_PAT && env?.DOCKER_HUB_USER) {
    const cred = btoa(`${env.DOCKER_HUB_USER}:${env.DOCKER_HUB_PAT}`);
    reqHeaders.set('authorization', `Basic ${cred}`);
    injectedPAT = true;
  }

  const req = new Request(upstream, {
    method: request.method,
    headers: reqHeaders,
    redirect: 'manual',
  });

  let res;
  try {
    res = await fetch(req);
  } catch (err) {
    return errorResponse(502, `Auth relay failed: ${err.message}`);
  }

  // Only cache anonymous tokens (no client credentials, no injected PAT).
  // Authenticated tokens are per-user and must not be shared.
  const cacheable = !hasClientAuth && !injectedPAT;
  if (res.status === 200 && cacheable) {
    try {
      const cloned = res.clone();
      const data = await cloned.json();
      if (data?.token) {
        const service = upstream.searchParams.get('service') || AUTH_SERVICES[host] || host;
        const scope = upstream.searchParams.get('scope') || '';
        await setCachedToken(host, service, scope, data.token, data.expires_in);
      }
    } catch {
      // Token parse failed — proceed without caching
    }
  }

  const headers = sanitizeHeaders(res.headers);
  headers.set('cache-control', 'no-store');
  headers.set('cdn-cache', 'no-store');
  withCors(headers);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Main Docker Registry proxy handler.
 *
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
export async function proxyRegistry(request, env) {
  const url = new URL(request.url);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(405, 'Method not allowed');
  }

  const target = parseRegistryPath(url.pathname, url.search);
  if (!target) {
    return errorResponse(404, 'Unknown registry path');
  }

  // Auth token relay
  if (target.isAuth) {
    return handleAuth(target.upstream, request, target.host, env);
  }

  // Access control: check image name
  const imageName = extractImageName(target.path);
  if (imageName) {
    const access = checkAccess(imageName, env);
    if (!access.allowed) {
      return errorResponse(403, `Access denied: ${access.reason}`);
    }
  }

  // Pre-inject cached auth token to skip 401 round-trip.
  // If the client already has an Authorization header, respect it.
  // Otherwise, check the Cache API for a previously obtained token
  // scoped to this registry + repository.
  const reqHeaders = sanitizeRequestHeaders(request.headers);
  if (!reqHeaders.has('authorization')) {
    const service = AUTH_SERVICES[target.host] || target.host;
    const scope = getScopeForPath(target.path);
    const cachedToken = await getCachedToken(target.host, service, scope);
    if (cachedToken) {
      reqHeaders.set('authorization', `Bearer ${cachedToken}`);
    }
  }

  // Fetch upstream
  const upstreamReq = new Request(target.upstream, {
    method: request.method,
    headers: reqHeaders,
    redirect: 'manual',
  });

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamReq);
  } catch (err) {
    return errorResponse(502, `Registry fetch failed: ${err.message}`);
  }

  // Follow upstream redirects for registry requests.
  // Some registries (k8s.io, Quay CDN) redirect manifests and blobs to
  // regional backends or CDNs. Docker daemon does not follow external
  // redirects, so we fetch and return the content ourselves.
  // Strip the Authorization header when redirecting to a different host
  // to avoid leaking registry credentials to third-party CDNs.
  let redirectCount = 0;
  while (upstreamRes.status >= 300 && upstreamRes.status < 400 && redirectCount < 5) {
    const location = upstreamRes.headers.get('location');
    if (!location) break;
    redirectCount++;
    try {
      const redirectUrl = new URL(location, target.upstream);
      const redirectReq = new Request(redirectUrl, {
        method: request.method,
        headers: reqHeaders,
        redirect: 'manual',
      });
      // Don't send registry credentials to a different host (e.g. CDN)
      if (redirectUrl.host !== target.upstream.host) {
        redirectReq.headers.delete('authorization');
      }
      upstreamRes = await fetch(redirectReq);
    } catch (err) {
      return errorResponse(502, `Registry redirect fetch failed: ${err.message}`);
    }
  }

  // Ensure Docker-Distribution-API-Version header on /v2 base endpoint
  const isV2Base = target.path === '/v2' || target.path === '/v2/';

  // Handle 401: route authentication appropriately per registry.
  //
  // Docker Hub: pass through the upstream www-authenticate unchanged so the
  //   Docker daemon authenticates directly with auth.docker.io. This way
  //   users only need `docker login docker.io` and get their 200/6h quota.
  //
  // Other registries (ghcr.io, quay.io, etc.): rewrite realm to our /token
  //   endpoint. The Docker daemon won't send credentials to a different host
  //   than the registry it's pulling from, so we must proxy the auth request.
  //   The daemon requests /token?service=ghcr.io&scope=... from us, we forward
  //   to the upstream auth service and return the token.
  //
  // If we pre-injected a cached token that turned out to be stale/invalid,
  // evict it from the cache so the next request gets a fresh token.
  if (upstreamRes.status === 401) {
    const service = AUTH_SERVICES[target.host] || target.host;
    const scope = getScopeForPath(target.path);
    await deleteCachedToken(target.host, service, scope);

    const wwwAuth = upstreamRes.headers.get('www-authenticate');
    if (wwwAuth) {
      const headers = sanitizeHeaders(upstreamRes.headers);
      // For Docker Hub: keep original realm (auth.docker.io)
      // For other registries: rewrite realm to our /token endpoint
      const isDockerHub = target.host === 'registry-1.docker.io';
      if (!isDockerHub) {
        const tokenPath = '/token';
        const realm = `${url.origin}${tokenPath}`;
        const rewritten = wwwAuth.replace(/realm="[^"]*"/, `realm="${realm}"`);
        headers.set('www-authenticate', rewritten);
      }
      headers.set('cache-control', 'no-store');
      headers.set('cdn-cache', 'no-store');
      if (isV2Base) headers.set('docker-distribution-api-version', 'registry/2.0');
      withCors(headers);
      return new Response(upstreamRes.body, {
        status: 401,
        statusText: upstreamRes.statusText,
        headers,
      });
    }
  }

  // Build response
  const headers = sanitizeHeaders(upstreamRes.headers);
  withCors(headers);

  // Don't cache error responses (4xx/5xx) — they're transient
  if (upstreamRes.status >= 400) {
    headers.set('cache-control', 'no-store');
    headers.set('cdn-cache', 'no-store');
    if (isV2Base) headers.set('docker-distribution-api-version', 'registry/2.0');
    const body = request.method === 'HEAD' ? null : upstreamRes.body;
    return new Response(body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers,
    });
  }

  // Cache blob layers (immutable content-addressed)
  if (target.path.includes('/blobs/')) {
    headers.set('cache-control', 'public, max-age=86400, immutable');
    headers.set('cdn-cache', 'public, max-age=86400');
  } else {
    headers.set('cache-control', 'public, max-age=300');
    headers.set('cdn-cache', 'public, max-age=300');
  }
  if (isV2Base) headers.set('docker-distribution-api-version', 'registry/2.0');

  const body = request.method === 'HEAD' ? null : upstreamRes.body;
  return new Response(body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers,
  });
}




