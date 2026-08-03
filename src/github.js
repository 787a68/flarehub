/**
 * GitHub, Hugging Face, and Docker binary download proxy.
 *
 * Handles proxying for:
 * - GitHub: releases, archives, codeload, raw, gist, API, static assets
 * - Hugging Face: resolve, blob, raw, CDN LFS
 * - Docker binary: download.docker.com
 */

import { corsPreflight, errorResponse, redirectResponse, sanitizeHeaders, sanitizeRequestHeaders, cacheHeaders, withCors } from './http.js';
import { checkAccess } from './access.js';

/** Upstream host → upstream base URL mapping. */
const HOSTS = {
  // GitHub
  'github.com': 'https://github.com',
  'raw.githubusercontent.com': 'https://raw.githubusercontent.com',
  'api.github.com': 'https://api.github.com',
  'codeload.github.com': 'https://codeload.github.com',
  'github.githubassets.com': 'https://github.githubassets.com',
  'gist.github.com': 'https://gist.github.com',
  'gist.githubusercontent.com': 'https://gist.githubusercontent.com',
  // Hugging Face
  'huggingface.co': 'https://huggingface.co',
  'cdn-lfs.hf.co': 'https://cdn-lfs.hf.co',
  'cdn-lfs-us-1.hf.co': 'https://cdn-lfs-us-1.hf.co',
  // Docker binary
  'download.docker.com': 'https://download.docker.com',
};

/** Hosts that serve HTML pages (not proxied as-is). */
const HTML_HOSTS = new Set(['github.com', 'huggingface.co', 'gist.github.com']);

/** GitHub blob path pattern: /owner/repo/blob/branch/path → raw. */
const BLOB_RE = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/;

/**
 * Extract owner/repo from a GitHub-style path for access control.
 * Returns null if the path doesn't match the expected pattern.
 */
function extractOwnerRepo(pathname) {
  const m = pathname.match(/^\/([^/]+)\/([^/]+)\//);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Rewrite a GitHub blob URL to its raw equivalent.
 * /owner/repo/blob/branch/file → /owner/repo/raw/branch/file
 */
function rewriteBlob(pathname) {
  return pathname.replace(BLOB_RE, '/$1/$2/raw/$3');
}

/**
 * Parse the incoming request to determine the upstream target.
 *
 * Supports two URL formats:
 * 1. /host/path  →  https://host/path
 * 2. /https://host/path  →  https://host/path
 *
 * @returns {{ host: string, url: URL, isHtml: boolean } | null}
 */
function parseTarget(pathname) {
  // Format 2: full URL embedded in path
  if (pathname.startsWith('/https://')) {
    try {
      const url = new URL(pathname.slice(1));
      return { host: url.hostname, url, isHtml: false };
    } catch {
      return null;
    }
  }

  // Format 1: /host/path
  const stripped = pathname.slice(1); // remove leading /
  const slashIdx = stripped.indexOf('/');
  if (slashIdx === -1) return null;

  const host = stripped.slice(0, slashIdx);
  const rest = stripped.slice(slashIdx);
  const base = HOSTS[host];
  if (!base) return null;

  return { host, url: new URL(rest, base), isHtml: HTML_HOSTS.has(host) };
}

/**
 * Main proxy handler for GitHub / HF / Docker binary.
 *
 * @param {Request} request
 * @param {object} env - Worker environment
 * @param {boolean} isHtml - Whether the target host serves HTML pages
 * @returns {Promise<Response>}
 */
export async function proxyGithub(request, env) {
  const url = new URL(request.url);

  // OPTIONS preflight
  if (request.method === 'OPTIONS') {
    return corsPreflight();
  }

  // Only allow safe methods
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(405, 'Method not allowed');
  }

  const target = parseTarget(url.pathname);
  if (!target) {
    return errorResponse(404, 'Unknown upstream host');
  }

  // Block HTML page proxying (we only proxy files, archives, API)
  if (target.isHtml) {
    const path = target.url.pathname;
    // Allow specific non-HTML paths on github.com / huggingface.co
    const isFile =
      path.includes('/releases/download/') ||
      path.includes('/archive/') ||
      path.includes('/blob/') ||
      path.includes('/resolve/') ||
      /\.(zip|tar\.gz|tgz|tar|gz|bz2|7z|whl|egg|jar|deb|rpm|msi|exe|dmg|pkg|apk|crate|gem|iso|dat|bin)$/i.test(path);

    if (!isFile && !path.startsWith('/api.') && target.host !== 'api.github.com') {
      // For github.com paths that aren't files, try blob→raw rewrite
      if (target.host === 'github.com' && BLOB_RE.test(path)) {
        target.url = new URL(rewriteBlob(path), 'https://raw.githubusercontent.com');
        target.isHtml = false;
      } else {
        return errorResponse(403, 'HTML pages are not proxied');
      }
    }
  }

  // Access control: check owner/repo for GitHub, path for others
  const ownerRepo = extractOwnerRepo(target.url.pathname);
  const accessTarget = ownerRepo || target.url.pathname;
  const access = checkAccess(accessTarget, env);
  if (!access.allowed) {
    return errorResponse(403, `Access denied: ${access.reason}`);
  }

  // Build upstream request
  const upstreamUrl = target.url;
  const upstreamReq = new Request(upstreamUrl, {
    method: request.method,
    headers: sanitizeRequestHeaders(request.headers),
    redirect: 'manual',
  });

  // Fetch upstream
  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamReq);
  } catch (err) {
    return errorResponse(502, `Upstream fetch failed: ${err.message}`);
  }

  // Handle redirects: rewrite Location to point through the proxy
  if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
    const location = upstreamRes.headers.get('location');
    if (location) {
      const absolute = new URL(location, upstreamUrl);
      // Primary format: /host/path (without protocol)
      const redirectPath = '/' + absolute.hostname + absolute.pathname + absolute.search + absolute.hash;
      return redirectResponse(redirectPath, upstreamRes.status);
    }
  }

  // Build response with sanitized + cache headers
  const respHeaders = sanitizeHeaders(upstreamRes.headers);
  const cache = cacheHeaders(upstreamUrl, upstreamRes.headers);
  for (const [k, v] of cache) respHeaders.set(k, v);
  withCors(respHeaders);

  // Stream the body
  const body = request.method === 'HEAD' ? null : upstreamRes.body;
  return new Response(body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: respHeaders,
  });
}


