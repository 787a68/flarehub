/**
 * GitHub, Hugging Face, and Docker binary download proxy.
 *
 * Handles proxying for:
 * - GitHub: releases, archives, codeload, raw, gist, API, static assets
 * - GitLab: raw, archives, releases, API
 * - Hugging Face: resolve, blob, raw, CDN LFS
 * - Docker binary: download.docker.com
 */

import { errorResponse, sanitizeHeaders, sanitizeRequestHeaders, cacheHeaders, withCors, isStaticAsset, ensureS3Headers, isAmazonS3 } from './http.js';
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
  'release-assets.githubusercontent.com': 'https://release-assets.githubusercontent.com',
  // Hugging Face
  'huggingface.co': 'https://huggingface.co',
  'cdn-lfs.hf.co': 'https://cdn-lfs.hf.co',
  'cdn-lfs-us-1.hf.co': 'https://cdn-lfs-us-1.hf.co',
  // Docker binary
  'download.docker.com': 'https://download.docker.com',
  // GitLab
  'gitlab.com': 'https://gitlab.com',
  'gitlab.freedesktop.org': 'https://gitlab.freedesktop.org',
  'gitlab.gnome.org': 'https://gitlab.gnome.org',
  'gitlab.kitware.com': 'https://gitlab.kitware.com',
  'gitlab.archlinux.org': 'https://gitlab.archlinux.org',
  'gitlab.postmarketos.org': 'https://gitlab.postmarketos.org',
};

/** Hosts that serve HTML pages (not proxied as-is). */
const HTML_HOSTS = new Set([
  'github.com', 'huggingface.co', 'gist.github.com',
  'gitlab.com', 'gitlab.freedesktop.org', 'gitlab.gnome.org',
  'gitlab.kitware.com', 'gitlab.archlinux.org', 'gitlab.postmarketos.org',
]);

/** All GitLab instances for access-control path parsing. */
const GITLAB_HOSTS = new Set([
  'gitlab.com', 'gitlab.freedesktop.org', 'gitlab.gnome.org',
  'gitlab.kitware.com', 'gitlab.archlinux.org', 'gitlab.postmarketos.org',
]);

/** Hosts that support Git smart-http protocol (git clone). */
const GIT_CAPABLE_HOSTS = new Set([
  'github.com', 'codeload.github.com',
  ...GITLAB_HOSTS,
]);

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

  if (GITLAB_HOSTS.has(host)) {
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
 * github.com/owner/repo/blob/branch/file
 *   → raw.githubusercontent.com/owner/repo/branch/file
 * The "/blob" segment is dropped (it is NOT replaced with "/raw": that is a
 * GitLab convention; raw.githubusercontent.com uses owner/repo/branch/path).
 */
function rewriteBlob(pathname) {
  return pathname.replace(BLOB_RE, '/$1/$2/$3');
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
 * Detect Git smart-http protocol requests (git clone / fetch / push).
 * Checks User-Agent and URL path patterns.
 */
function isGitRequest(request, pathname) {
  const ua = (request.headers.get('user-agent') || '').toLowerCase();
  if (ua.includes('git/')) return true;

  // Git smart-http endpoints
  if (pathname.includes('/info/refs') ||
      pathname.includes('/git-upload-pack') ||
      pathname.includes('/git-receive-pack')) {
    return true;
  }

  return false;
}

/**
 * Build minimal headers for Git smart-http requests.
 * Strips all Cloudflare/proxy/internal headers to avoid interference.
 */
function buildGitHeaders(request) {
  const headers = new Headers();
  const preserve = [
    'accept', 'accept-encoding', 'accept-language',
    'authorization', 'content-type', 'content-encoding',
    'git-protocol', 'user-agent', 'pragma',
  ];
  for (const key of preserve) {
    const val = request.headers.get(key);
    if (val) headers.set(key, val);
  }
  return headers;
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

  const target = parseTarget(url.pathname, url.search);
  if (!target) {
    return errorResponse(404, 'Unknown upstream host');
  }

  // Detect Git smart-http requests (git clone support)
  const gitRequest = GIT_CAPABLE_HOSTS.has(target.host) && isGitRequest(request, target.url.pathname);

  // Only allow safe methods; Git requests need POST for git-upload-pack
  const allowedMethods = gitRequest ? ['GET', 'HEAD', 'POST'] : ['GET', 'HEAD'];
  if (!allowedMethods.includes(request.method)) {
    return errorResponse(405, 'Method not allowed');
  }

  // Block HTML page proxying (we only proxy files, archives, API)
  // Skip for Git requests — they use smart-http endpoints, not HTML pages
  if (!gitRequest && target.isHtml) {
    const path = target.url.pathname;

    // Rewrite blob pages to their raw equivalent BEFORE the static-asset
    // check, otherwise blob files with a static extension (e.g. .zip) would
    // pass isStaticAsset() and get fetched as the HTML blob page.
    if (target.host === 'github.com' && BLOB_RE.test(path)) {
      target.url = new URL(rewriteBlob(path), 'https://raw.githubusercontent.com');
      target.isHtml = false;
    // GitLab: /-/blob/ → /-/raw/ rewrite (same host)
    } else if (GITLAB_HOSTS.has(target.host) && GITLAB_BLOB_RE.test(path)) {
      target.url = new URL(path.replace(GITLAB_BLOB_RE, '/-/raw/'), HOSTS[target.host]);
      target.isHtml = false;
    // Allow specific non-HTML paths on HTML hosts
    } else if (!isStaticAsset(path) && !path.startsWith('/api.') && !path.startsWith('/api/')) {
      return errorResponse(403, 'HTML pages are not proxied');
    }
  }

  const access = checkAccess(accessTarget(target.host, target.url.pathname), env);
  if (!access.allowed) {
    return errorResponse(403, `Access denied: ${access.reason}`);
  }

  // Git smart-http: use redirect:follow and pass request body (POST git-upload-pack)
  if (gitRequest) {
    const gitHeaders = buildGitHeaders(request);
    try {
      const upstreamRes = await fetch(new Request(target.url, {
        method: request.method,
        headers: gitHeaders,
        body: request.method === 'POST' ? request.body : null,
        redirect: 'follow',
      }));

      const respHeaders = sanitizeHeaders(upstreamRes.headers);
      withCors(respHeaders);

      const body = request.method === 'HEAD' ? null : upstreamRes.body;
      return new Response(body, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      console.error('Git upstream fetch failed', err);
      return errorResponse(502, 'Upstream fetch failed');
    }
  }

  // Non-Git requests: follow redirects inside the Worker so credentials can be
  // removed before crossing hosts and clients never receive a proxy URL.
  let upstreamUrl = target.url;
  const upstreamHeaders = sanitizeRequestHeaders(request.headers);
  const authenticated = upstreamHeaders.has('authorization');
  let upstreamRes;

  try {
    for (let redirects = 0; ; redirects++) {
      // Add AWS S3/CloudFront required headers when redirected to amazonaws.com
      ensureS3Headers(upstreamUrl, upstreamHeaders);

      upstreamRes = await fetch(new Request(upstreamUrl, {
        method: request.method,
        headers: upstreamHeaders,
        redirect: 'manual',
      }));

      if (upstreamRes.status < 300 || upstreamRes.status >= 400) break;
      const location = upstreamRes.headers.get('location');
      if (!location) break;
      if (redirects >= 5) return errorResponse(508, 'Too many upstream redirects');

      const nextUrl = new URL(location, upstreamUrl);
      if (nextUrl.protocol !== 'https:') {
        return errorResponse(502, 'Unsupported upstream redirect');
      }
      // Allow redirects to known proxy hosts or AWS S3/CloudFront CDN
      if (!HOSTS[nextUrl.hostname] && !isAmazonS3(nextUrl)) {
        return errorResponse(502, 'Unsupported upstream redirect');
      }
      if (nextUrl.host !== upstreamUrl.host) upstreamHeaders.delete('authorization');
      upstreamUrl = nextUrl;
    }
  } catch (err) {
    console.error('Upstream fetch failed', err);
    return errorResponse(502, 'Upstream fetch failed');
  }

  // Build response with sanitized + cache headers
  const respHeaders = sanitizeHeaders(upstreamRes.headers);
  const cache = cacheHeaders(
    upstreamUrl,
    upstreamRes.headers,
    authenticated,
  );
  for (const [k, v] of cache) respHeaders.set(k, v);
  withCors(respHeaders);

  // Default: force download (Content-Disposition: attachment).
  // ?preview=1: switch to inline so the browser displays the content.
  //   For safety, HTML content-types are forced to text/plain to prevent
  //   rendering (anti-phishing). Images keep their original type.
  const isPreview = url.searchParams.has('preview');
  // Extract filename from the ORIGINAL request path, not the redirected URL.
  // When upstream redirects to a CDN (e.g. objects.githubusercontent.com),
  // the CDN URL's final segment is an opaque token without the file extension,
  // causing the downloaded file to lose its suffix.
  const pathParts = target.url.pathname.split('/');
  const rawName = pathParts[pathParts.length - 1] || 'download';
  let filename;
  try { filename = decodeURIComponent(rawName); } catch { filename = rawName; }
  filename = filename.replace(/"/g, '_');
  if (isPreview) {
    respHeaders.set('content-disposition', `inline; filename="${filename}"`);
    // Anti-phishing: never let the browser render HTML in preview mode.
    const ct = (respHeaders.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (ct === 'text/html' || ct === 'application/xhtml+xml') {
      respHeaders.set('content-type', 'text/plain; charset=utf-8');
    }
  } else {
    respHeaders.set('content-disposition', `attachment; filename="${filename}"`);
    // Use application/octet-stream in download mode so browsers don't append
    // a suffix (e.g. .txt) based on the upstream text/plain MIME type.
    respHeaders.set('content-type', 'application/octet-stream');
  }

  // Stream the body
  const body = request.method === 'HEAD' ? null : upstreamRes.body;
  return new Response(body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: respHeaders,
  });
}


