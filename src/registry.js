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
const REGISTRIES = {
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
  'gcr.io': { base: 'https://gcr.io', path: '/v2/auth' },
  'registry.k8s.io': { base: 'https://registry.k8s.io', path: '/v2/auth' },
};

/**
 * Parse the incoming path to determine the target registry.
 *
 * Path formats:
 * - /v2/...                    → Docker Hub (default)
 * - /ghcr.io/v2/...            → GHCR
 * - /quay.io/v2/...            → Quay
 * - /registry.k8s.io/v2/...   → k8s registry
 * - /token?...                 → Docker Hub auth
 * - /ghcr.io/token?...         → GHCR auth
 *
 * @returns {{ host: string, upstream: URL, path: string } | null}
 */
function parseRegistryPath(pathname, search) {
  // Auth token endpoint: /token or /<host>/token
  if (pathname === '/token' || pathname.endsWith('/token')) {
    const hostMatch = pathname.match(/^\/([^/]+)\/token$/);
    const host = hostMatch ? hostMatch[1] : 'registry-1.docker.io';
    const ep = AUTH_ENDPOINTS[host] || AUTH_ENDPOINTS['registry-1.docker.io'];
    return {
      host,
      upstream: new URL(`${ep.path}${search}`, ep.base),
      path: ep.path,
      isAuth: true,
    };
  }

  // /v2 and /v2/... → Docker Hub
  if (pathname === '/v2' || pathname === '/v2/' || pathname.startsWith('/v2/')) {
    return {
      host: 'registry-1.docker.io',
      upstream: new URL(pathname + search, 'https://registry-1.docker.io'),
      path: pathname,
      isAuth: false,
    };
  }

  // /<host>/v2/... → other registries
  const m = pathname.match(/^\/([^/]+)\/(v2\/.*)$/);
  if (m) {
    const host = m[1];
    const rest = m[2];
    const base = REGISTRIES[host];
    if (!base) return null;
    return {
      host,
      upstream: new URL(`/${rest}${search}`, base),
      path: `/${rest}`,
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
 */
async function handleAuth(upstream, request) {
  const req = new Request(upstream, {
    method: request.method,
    headers: sanitizeRequestHeaders(request.headers),
    redirect: 'manual',
  });

  let res;
  try {
    res = await fetch(req);
  } catch (err) {
    return errorResponse(502, `Auth relay failed: ${err.message}`);
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
    return handleAuth(target.upstream, request);
  }

  // Access control: check image name
  const imageName = extractImageName(target.path);
  if (imageName) {
    const access = checkAccess(imageName, env);
    if (!access.allowed) {
      return errorResponse(403, `Access denied: ${access.reason}`);
    }
  }

  // Fetch upstream
  const upstreamReq = new Request(target.upstream, {
    method: request.method,
    headers: sanitizeRequestHeaders(request.headers),
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
  let redirectCount = 0;
  while (upstreamRes.status >= 300 && upstreamRes.status < 400 && redirectCount < 5) {
    const location = upstreamRes.headers.get('location');
    if (!location) break;
    redirectCount++;
    try {
      const redirectUrl = new URL(location, target.upstream);
      const redirectReq = new Request(redirectUrl, {
        method: request.method,
        headers: sanitizeRequestHeaders(request.headers),
        redirect: 'manual',
      });
      upstreamRes = await fetch(redirectReq);
    } catch (err) {
      return errorResponse(502, `Registry redirect fetch failed: ${err.message}`);
    }
  }

  // Ensure Docker-Distribution-API-Version header on /v2 base endpoint
  const isV2Base = target.path === '/v2' || target.path === '/v2/';

  // Handle 401: rewrite www-authenticate to point through proxy
  if (upstreamRes.status === 401) {
    const wwwAuth = upstreamRes.headers.get('www-authenticate');
    if (wwwAuth) {
      const rewritten = rewriteWwwAuthenticate(wwwAuth, target.host, url);
      const headers = sanitizeHeaders(upstreamRes.headers);
      headers.set('www-authenticate', rewritten);
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

/**
 * Rewrite the www-authenticate header to point the client
 * to the proxy's /token endpoint instead of the upstream auth.
 *
 * Example:
 *   Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"
 * →
 *   Bearer realm="https://your-domain.com/token",service="registry.docker.io",scope="repository:library/nginx:pull"
 */
function rewriteWwwAuthenticate(header, host, proxyUrl) {
  // Build the proxy's token endpoint URL
  const tokenPath = host === 'registry-1.docker.io' ? '/token' : `/${host}/token`;
  const realm = `${proxyUrl.origin}${tokenPath}`;

  // Replace the realm= value in the Bearer challenge
  return header.replace(
    /realm="[^"]*"/,
    `realm="${realm}"`
  );
}


