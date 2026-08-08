/**
 * HTTP utilities: CORS, error responses, header sanitization, caching.
 */

/** Headers that must be stripped from upstream responses. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate',   'proxy-authorization',
  'cookie',
  'te', 'trailer', 'transfer-encoding', 'set-cookie', 'upgrade',
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

/** CDN hosts that always serve immutable content-addressed data. */
export const CDN_HOSTS = new Set([
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'cdn-lfs.hf.co',
  'cdn-lfs-us-1.hf.co',
]);

/**
 * Hosts serving unlisted-but-unauthenticated content (secret gists).
 * Their URLs act as bearer capabilities: anyone holding the URL can read the
 * content, and the owner's only revocation mechanism is deleting it upstream.
 * Caching such responses at the edge would keep serving copies after upstream
 * deletion, so they are always marked no-store.
 */
export const UNLISTED_CONTENT_HOSTS = new Set([
  'gist.github.com',
  'gist.githubusercontent.com',
]);

/**
 * Classify the client's Authorization header.
 *
 * - 'bearer' — an upstream-issued, short-lived, scope-limited token. Required
 *   by the Docker Registry v2 flow: the daemon retries with this token after a
 *   401 challenge, so it must be forwarded for registry mirrors to work.
 * - 'basic'  — base64 is reversible encoding, not encryption. These are
 *   long-lived plaintext credentials that a public read-only proxy must never
 *   receive or forward.
 * - 'other'  — unrecognized scheme. Rejected by default: a whitelist is safer
 *   than a blacklist when the payload may contain long-lived secrets.
 * - 'none'   — no credentials (the overwhelming majority of traffic).
 *
 * @param {Headers} headers
 * @returns {'bearer'|'basic'|'other'|'none'}
 */
export function classifyAuth(headers) {
  const auth = headers.get('authorization');
  if (!auth) return 'none';
  const scheme = auth.trim().split(/\s+/)[0].toLowerCase();
  if (scheme === 'bearer') return 'bearer';
  if (scheme === 'basic') return 'basic';
  return 'other';
}

/** SHA-256 of an empty body — required by AWS S3 / CloudFront for GET requests. */
const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * Check if a URL (or hostname string) points to AWS S3 / CloudFront.
 * These hosts require x-amz-content-sha256 and x-amz-date headers.
 */
export function isAmazonS3(urlOrHost) {
  try {
    const host = typeof urlOrHost === 'string' && !urlOrHost.includes('://')
      ? urlOrHost
      : new URL(urlOrHost).hostname;
    return host.includes('amazonaws.com') || host.includes('cloudfront.net');
  } catch {
    return false;
  }
}

/**
 * Generate the current UTC timestamp in AWS date format: YYYYMMDDTHHMMSSZ.
 */
export function getAmzDate() {
  return new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
}

/**
 * Ensure AWS S3 / CloudFront required headers are present.
 * Adds x-amz-content-sha256 (empty body hash) and x-amz-date.
 * Should be called before every fetch to an amazonaws.com / cloudfront.net host.
 */
export function ensureS3Headers(url, headers) {
  if (!isAmazonS3(url)) return headers;
  headers.set('x-amz-content-sha256', EMPTY_BODY_SHA256);
  headers.set('x-amz-date', getAmzDate());
  return headers;
}

/** File extension pattern for static (immutable) content. Shared across modules. */
export const FILE_EXT_RE = /\.(zip|tar\.gz|tgz|tar|gz|bz2|7z|iso|exe|msi|deb|rpm|dmg|pkg|jar|war|whl|egg|gem|crate|apk|dll|so|dylib|bin|img|dat|db|sqlite|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|svg|ico|bmp|mp[34]|wav|flac|ogg|avi|mov|mkv|webm|pdf|epub|mobi|cbz|cbr)$/i;

/**
 * Check if a path points to static (immutable) content.
 * Used for cache header generation. Note: /blob/ is intentionally excluded
 * because blob paths on HTML hosts need rewriting to raw, not direct fetch.
 */
export function isStaticAsset(path) {
  return path.includes('/releases/download/') ||
    path.includes('/archive/') ||
    path.includes('/codeload') ||
    path.includes('/resolve/') ||
    path.includes('/raw/') ||
    FILE_EXT_RE.test(path);
}

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
 * Remove host, origin, referer, and most CF-specific headers.
 *
 * @param {Headers} headers
 * @param {boolean} preserveClientIp - When true, keep cf-connecting-ip so
 *   Docker Hub can identify the real client IP for rate limiting. Without it,
 *   Docker Hub falls back to the shared Cloudflare Workers egress IP, causing
 *   429 for all users in the same anonymous rate-limit pool. Only the Docker
 *   Registry proxy should set this; other proxies strip it to protect privacy.
 */
export function sanitizeRequestHeaders(headers, preserveClientIp = false) {
  const out = new Headers(headers);
  out.delete('host');
  out.delete('origin');
  out.delete('referer');
  out.delete('cookie');
  if (!preserveClientIp) {
    out.delete('cf-connecting-ip');
  }
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
  out.set('x-content-type-options', 'nosniff');
  return out;
}

/**
 * Build cache-control directives for proxied responses.
 * Static assets get long cache; everything else gets short edge cache.
 *
 * @param {URL} url - Final upstream URL (after redirects).
 * @param {Headers} existing - Upstream response headers.
 * @param {boolean} authenticated - Client supplied its own credentials.
 * @param {string} [originHost] - Host originally requested, before redirects.
 *   Needed so unlisted content keeps its no-store treatment even if upstream
 *   redirects it to a CDN host.
 */
export function cacheHeaders(url, existing, authenticated = false, originHost = '') {
  const cache = new Headers();
  const cc = existing?.get('cache-control') || '';

  // Never share authenticated or explicitly private responses.
  if (authenticated || /no-store|no-cache|private/i.test(cc) || existing?.has('set-cookie')) {
    cache.set('cache-control', 'private, no-store');
    cache.set('cdn-cache-control', 'no-store');
    return cache;
  }

  // Secret gists are protected only by an unguessable URL. Never retain a
  // shared copy: the edge would otherwise outlive upstream deletion.
  if (UNLISTED_CONTENT_HOSTS.has(url.hostname) || UNLISTED_CONTENT_HOSTS.has(originHost)) {
    cache.set('cache-control', 'private, no-store');
    cache.set('cdn-cache-control', 'no-store');
    return cache;
  }

  // Long-lived static assets: releases, archives, codeload, raw, CDN.
  if (isStaticAsset(url.pathname) || CDN_HOSTS.has(url.hostname)) {
    cache.set('cache-control', 'public, max-age=86400, immutable');
    cache.set('cdn-cache-control', 'public, max-age=86400');
    return cache;
  }

  // Default: short browser and edge cache.
  cache.set('cache-control', 'public, max-age=300');
  cache.set('cdn-cache-control', 'public, max-age=300');
  return cache;
}

/** Handle CORS preflight (OPTIONS) requests. */
export function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: withCors(new Headers()),
  });
}
