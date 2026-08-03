// GitHub / HuggingFace / Docker Binary proxy — patterned after hubproxy
import { HttpError } from './http.js';

// ── URL matching patterns (mirrors hubproxy's githubExps) ──────────────────
const PATTERNS = [
  // blob → raw conversion: github.com/{owner}/{repo}/blob/{ref}/{path}
  { re: /^\/?(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/, raw: true },
  // GitHub pages: github.com/{owner}/{repo}/(releases|archive|tree|...)
  { re: /^\/?(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)\/(releases|archive|raw|tree|commits|issues|pulls|actions|milestones|discussions|wiki|projects|security|branches|tags|compare|labels)(\/.*)?$/, raw: false },
  // GitHub repo root: github.com/{owner}/{repo}
  { re: /^\/?(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)$/, raw: false },
  // GitHub raw: raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
  { re: /^\/?(?:https?:\/\/)?raw\.github(?:usercontent)?\.com\/.*$/, raw: false },
  // GitHub API: api.github.com/...
  { re: /^\/?(?:https?:\/\/)?api\.github\.com\/.*$/, raw: false },
  // GitHub codeload: codeload.github.com/{owner}/{repo}/(legacy.)?(zip|tar.gz)/{ref}
  { re: /^\/?(?:https?:\/\/)?codeload\.github\.com\/.*$/, raw: false },
  // GitHub assets: github.githubassets.com/...
  { re: /^\/?(?:https?:\/\/)?github\.githubassets\.com\/.*$/, raw: false },
  // GitHub gists: gist.github(usercontent)?.com/...
  { re: /^\/?(?:https?:\/\/)?gist\.github(?:usercontent)?\.com\/.*$/, raw: false },
  // HuggingFace resolve: huggingface.co/{user}/{repo}/resolve/{ref}/{path}
  { re: /^\/?(?:https?:\/\/)?huggingface\.co\/([^/]+)\/([^/]+)\/(?:resolve|raw|blob)\/(.+)$/, raw: false },
  // HuggingFace CDN LFS
  { re: /^\/?(?:https?:\/\/)?cdn-lfs(?:-us-1)?\.hf\.co\/.*$/, raw: false },
  // Docker binary download
  { re: /^\/?(?:https?:\/\/)?download\.docker\.com\/.*$/, raw: false },
];

// Content-type values that should NOT be downloaded as files
const BLOCKED_CONTENT_TYPES = [
  'text/html', 'application/json', 'text/javascript', 'application/xml', 'text/css',
];

// OpenSearch / Atom feeds that often redirect to gh-pages — proxy as-is
const FEED_PATHS = /\.(atom|xml)$/i;

/**
 * Check if the given path matches any prowable GitHub/HF/Docker domain.
 */
export function isGithubTarget(path) {
  if (!path) return false;
  return PATTERNS.some(p => p.re.test(path));
}

/**
 * Determine the upstream URL for a request path.
 * Returns { url, raw } — raw=true means rewrite blob→raw before fetch.
 */
export function githubTargetFromRequest(path) {
  if (!path) return null;
  const decoded = decodeURIComponent(path.replace(/^\/+/, ''));
  const upstream = decoded.startsWith('https://') ? decoded : `https://${decoded}`;
  const upstreamPath = upstream.replace(/^https?:\/\/[^/]+/, '');

  for (const { re, raw } of PATTERNS) {
    const m = re.exec(decoded);
    if (!m) continue;

    // blob → raw rewrite
    if (raw && m[1] && m[2] && m[3] && m[4]) {
      return {
        url: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`,
        raw: true,
      };
    }

    return { url: upstream, raw: false };
  }

  return null;
}

/**
 * Parse a GitHub URL into owner/repo/target parts.
 * Useful for UI display and access control.
 */
export function parseGithubTarget(path) {
  if (!path) return null;
  const decoded = decodeURIComponent(path.replace(/^\/+/, ''));
  const urlStr = decoded.startsWith('https://') ? decoded : `https://${decoded}`;

  let info = null;

  // Try to extract from raw.githubusercontent.com
  const rawMatch = urlStr.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/);
  if (rawMatch) {
    return {
      host: 'raw.githubusercontent.com',
      owner: rawMatch[1], repo: rawMatch[2], ref: rawMatch[3], path: rawMatch[4],
    };
  }

  // Try hugingface.co
  const hfMatch = urlStr.match(/huggingface\.co\/([^/]+)\/([^/]+)\/(?:resolve|raw|blob)\/(.*)$/);
  if (hfMatch) {
    return { host: 'huggingface.co', owner: hfMatch[1], repo: hfMatch[2], ref: hfMatch[2], path: hfMatch[3] };
  }

  // Try github.com
  const ghMatch = urlStr.match(/github\.com\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (ghMatch) {
    return { host: 'github.com', owner: ghMatch[1], repo: ghMatch[2], path: ghMatch[3] || '' };
  }

  return null;
}

/**
 * Extract repository identity for access control / logging.
 */
export function githubRepository(parsed) {
  if (!parsed) return null;
  if (parsed.owner && parsed.repo) return `${parsed.owner}/${parsed.repo}`;
  return null;
}

/**
 * Determine whether a fetch response should be blocked (e.g. HTML page served as binary).
 * Mirrors hubproxy's blockedContentType check.
 */
function shouldBlockResponse(resp, url) {
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  if (!ct) return false;

  // Block HTML/json responses for raw/file endpoints
  if (BLOCKED_CONTENT_TYPES.some(t => ct.startsWith(t))) {
    // Allow GitHub.com HTML pages, HuggingFace repo pages, etc.
    const isPageEndpoint = /^https?:\/\/(github\.com|huggingface\.co)\/[^/]+\/[^/]+(?:\/(?:releases|tree|commits|issues|pulls|actions|discussions|wiki|branches|tags|compare|milestones|projects|security|labels))?\/?$/i.test(url);
    if (!isPageEndpoint) {
      return true;
    }
    // Feed paths — allow
    if (FEED_PATHS.test(url)) return false;
  }

  return false;
}

/**
 * Forward a request to the upstream and return a Response.
 * Closely mirrors hubproxy's forwardRequest + blockedContentType logic.
 */
export async function proxyGithub(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname + url.search;

  const target = githubTargetFromRequest(path);
  if (!target) throw new HttpError('Invalid proxy target', 400);

  let upstreamUrl = target.url;

  // Ensure upstream has the search part
  if (url.search && !upstreamUrl.includes('?')) {
    upstreamUrl += url.search;
  }

  // Build upstream request
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ipcountry');
  headers.delete('cf-ray');
  headers.delete('cf-visitor');
  headers.delete('x-forwarded-for');
  headers.delete('x-forwarded-proto');
  headers.set('host', new URL(upstreamUrl).host);

  // Accept redirects (GitHub/HF often redirect for releases, downloads)
  let upstreamReq = new Request(upstreamUrl, {
    method: request.method,
    headers,
    redirect: 'follow',
  });

  // POST/PUT — forward body
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    upstreamReq = new Request(upstreamUrl, {
      method: request.method,
      headers,
      redirect: 'follow',
      body: request.body,
      duplex: 'half',
    });
  }

  const upstreamResp = await fetch(upstreamReq);

  // Block inappropriate content types
  if (shouldBlockResponse(upstreamResp, upstreamUrl)) {
    return new Response('Not Found (blocked content type)', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  // Build response with proper CORS
  const respHeaders = new Headers();
  const hopByHop = ['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade'];
  for (const [k, v] of upstreamResp.headers) {
    if (hopByHop.includes(k.toLowerCase())) continue;
    // Don't pass through security headers from upstream
    if (k.toLowerCase().startsWith('content-security-policy')) continue;
    respHeaders.set(k, v);
  }
  respHeaders.set('access-control-allow-origin', '*');
  respHeaders.set('access-control-expose-headers', '*');
  respHeaders.set('x-proxied-by', 'flarehub');

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers: respHeaders,
  });
}
