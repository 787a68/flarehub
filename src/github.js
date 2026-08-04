/**
 * GitHub, Hugging Face, and Docker binary download proxy.
 *
 * Handles proxying for:
 * - GitHub: releases, archives, codeload, raw, gist, API, static assets
 * - GitLab: raw, archives, releases, API
 * - Hugging Face: resolve, blob, raw, CDN LFS
 * - Docker binary: download.docker.com
 */

import { errorResponse, redirectResponse, sanitizeHeaders, sanitizeRequestHeaders, cacheHeaders, withCors, isStaticAsset } from './http.js';
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
  'objects.githubusercontent.com': 'https://objects.githubusercontent.com',
  'github-releases.githubusercontent.com': 'https://github-releases.githubusercontent.com',
  // Hugging Face
  'huggingface.co': 'https://huggingface.co',
  'cdn-lfs.hf.co': 'https://cdn-lfs.hf.co',
  'cdn-lfs-us-1.hf.co': 'https://cdn-lfs-us-1.hf.co',
  // Docker binary
  'download.docker.com': 'https://download.docker.com',
  // GitLab
  'gitlab.com': 'https://gitlab.com',
};

/** Hosts that serve HTML pages (not proxied as-is). */
const HTML_HOSTS = new Set(['github.com', 'huggingface.co', 'gist.github.com', 'gitlab.com']);

/** GitHub blob path pattern: /owner/repo/blob/branch/path → raw. */
const BLOB_RE = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/;

/** GitLab blob path pattern: /-/blob/ → /-/raw/ (handles subgroups). */
const GITLAB_BLOB_RE = /\/-\/blob\//;

/** Build a stable access-control identifier for each upstream path shape. */
function accessTarget(host, pathname) {
  if (host === 'api.github.com') {
    const match = pathname.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/|$)/);
    return match ? `${match[1]}/${match[2]}` : pathname;
  }

  if (host === 'gitlab.com') {
    const projectEnd = pathname.indexOf('/-/');
    if (projectEnd > 1) return pathname.slice(1, projectEnd);
    return pathname;
  }

  if (host === 'huggingface.co') {
    const parts = pathname.split('/').filter(Boolean);
    const offset = parts[0] === 'datasets' || parts[0] === 'spaces' ? 1 : 0;
    if (parts.length >= offset + 2) return `${parts[offset]}/${parts[offset + 1]}`;
    return pathname;
  }

  const repositoryHosts = new Set([
    'github.com',
    'raw.githubusercontent.com',
    'codeload.github.com',
    'gist.github.com',
    'gist.githubusercontent.com',
  ]);
  if (repositoryHosts.has(host)) {
    const match = pathname.match(/^\/([^/]+)\/([^/]+)(?:\/|$)/);
    if (match) return `${match[1]}/${match[2]}`;
  }

  return pathname;
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
 * 1. /host/path?query  →  https://host/path?query
 * 2. /https://host/path?query  →  https://host/path?query
 *
 * @returns {{ host: string, url: URL, isHtml: boolean } | null}
 */
function parseTarget(pathname, search) {
  // Format 2: full URL embedded in path
  // Cloudflare may encode : as %3A in production
  if (pathname.startsWith('/https://') || pathname.startsWith('/https%3A/') || pathname.startsWith('/https%3a/')) {
    try {
      const raw = pathname.slice(1).replace(/^https%3[Aa]\//, 'https://') + search;
      const url = new URL(raw);
      if (!HOSTS[url.hostname]) return null;
      return { host: url.hostname, url, isHtml: HTML_HOSTS.has(url.hostname) };
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

  return { host, url: new URL(rest + search, base), isHtml: HTML_HOSTS.has(host) };
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

  // Only allow safe methods
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(405, 'Method not allowed');
  }

  const target = parseTarget(url.pathname, url.search);
  if (!target) {
    return errorResponse(404, 'Unknown upstream host');
  }

  // Block HTML page proxying (we only proxy files, archives, API)
  if (target.isHtml) {
    const path = target.url.pathname;
    // Allow specific non-HTML paths on HTML hosts
    if (!isStaticAsset(path) && !path.startsWith('/api.') && !path.startsWith('/api/')) {
      // GitHub: blob → raw.githubusercontent.com rewrite
      if (target.host === 'github.com' && BLOB_RE.test(path)) {
        target.url = new URL(rewriteBlob(path), 'https://raw.githubusercontent.com');
        target.isHtml = false;
      // GitLab: /-/blob/ → /-/raw/ rewrite (same host)
      } else if (target.host === 'gitlab.com' && GITLAB_BLOB_RE.test(path)) {
        target.url = new URL(path.replace(GITLAB_BLOB_RE, '/-/raw/'), 'https://gitlab.com');
        target.isHtml = false;
      } else {
        return errorResponse(403, 'HTML pages are not proxied');
      }
    }
  }

  const access = checkAccess(accessTarget(target.host, target.url.pathname), env);
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
    console.error('Upstream fetch failed', err);
    return errorResponse(502, 'Upstream fetch failed');
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
  const cache = cacheHeaders(
    upstreamUrl,
    upstreamRes.headers,
    upstreamReq.headers.has('authorization') || request.headers.has('cookie'),
  );
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


