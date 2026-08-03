/**
 * HTTP utilities: CORS, error responses, header sanitization, caching.
 */

/** Headers that must be stripped from upstream responses. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** Headers that reveal origin identity or break proxying. */
const STRIP = new Set([
  'cf-ray', 'cf-cache-status', 'cf-ipcountry', 'cf-visitor',
  'x-cache', 'x-served-by', 'x-cache-hits', 'x-timer',
  'server', 'via', 'x-amz-cf-id', 'x-amz-cf-pop',
  'x-github-request-id', 'x-github-frontend', 'x-accepted-github-permissions',
  'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-used',
  'x-ratelimit-resource', 'x-github-token-scopes',
  'x-accepted-oauth-scopes', 'x-oauth-scopes',
  'x-content-type-options', 'x-frame-options', 'x-xss-protection',
  'strict-transport-security', 'report-to', 'reporting-endpoints',
  'nel', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'content-security-policy',
  'permissions-policy', 'referrer-policy',
]);

/** CORS headers applied to all responses. */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400',
};

/** Merge CORS headers into a Headers-like object. */
export function withCors(headers) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return headers;
}

/** Build a JSON error response. */
export function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: withCors(new Headers({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })),
  });
}

/** Build a redirect response. */
export function redirectResponse(location, status = 302) {
  return new Response(null, {
    status,
    headers: withCors(new Headers({ 'location': location })),
  });
}

/**
 * Sanitize request headers before forwarding upstream.
 * Remove host, origin, referer, CF-specific, and identity-revealing headers.
 */
export function sanitizeRequestHeaders(headers) {
  const out = new Headers(headers);
  out.delete('host');
  out.delete('origin');
  out.delete('referer');
  out.delete('cf-connecting-ip');
  out.delete('cf-ipcountry');
  out.delete('cf-ray');
  out.delete('cf-visitor');
  out.delete('cf-worker');
  out.delete('true-client-ip');
  out.delete('x-forwarded-for');
  out.delete('x-forwarded-proto');
  out.delete('x-real-ip');
  return out;
}

/**
 * Sanitize upstream response headers for proxying.
 * Strips hop-by-hop, identity-revealing, and security headers
 * that would break the proxy or confuse clients.
 */
export function sanitizeHeaders(headers) {
  const out = new Headers();
  for (const [key, value] of headers) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || STRIP.has(lower)) continue;
    out.set(key, value);
  }
  return out;
}

/**
 * Build cache-control directives for proxied responses.
 * Static assets get long cache; everything else gets short edge cache.
 */
export function cacheHeaders(url, existing) {
  const cache = new Headers();
  const cc = existing?.get('cache-control') || '';

  // Preserve explicit no-store / no-cache from upstream
  if (/no-store|no-cache/i.test(cc)) {
    cache.set('cache-control', 'no-store');
    return cache;
  }

  // Long-lived static assets: releases, archives, blobs, codeload, CDN
  const path = url.pathname;
  if (
    path.includes('/releases/download/') ||
    path.includes('/archive/') ||
    path.includes('/codeload') ||
    path.includes('/resolve/') ||
    path.includes('/blob/') ||
    path.includes('/raw/') ||
    /\.(zip|tar\.gz|tgz|tar|gz|bz2|7z|iso|exe|msi|deb|rpm|dmg|pkg|jar|war|whl|egg|gem|crate|apk|dll|so|dylib|bin|img|dat|db|sqlite|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|svg|ico|bmp|mp[34]|wav|flac|ogg|avi|mov|mkv|webm|pdf|epub|mobi|cbz|cbr)$/i.test(path)
  ) {
    cache.set('cache-control', 'public, max-age=86400');
    cache.set('cdn-cache', 'public, max-age=86400');
    return cache;
  }

  // Default: short edge cache, revalidate with origin
  cache.set('cache-control', 'public, max-age=300, s-maxage=600');
  cache.set('cdn-cache', 'public, max-age=300');
  return cache;
}

/** Handle CORS preflight (OPTIONS) requests. */
export function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: withCors(new Headers()),
  });
}
