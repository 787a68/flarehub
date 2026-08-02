import { cacheOptions, downstreamResponse, fetchUpstream, HttpError, preflight, upstreamHeaders } from "./http.js";
import { enforceAccess } from "./access.js";

const HOSTS = new Set([
  "github.com", "www.github.com", "raw.githubusercontent.com", "api.github.com",
  "codeload.github.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com",
  "release-assets.githubusercontent.com", "github.githubassets.com", "gist.github.com",
  "gist.githubusercontent.com", "media.githubusercontent.com", "download.docker.com",
  "huggingface.co", "cdn-lfs.hf.co",
]);
const HOST_SUFFIXES = [".githubusercontent.com", ".githubassets.com", ".hf.co", ".huggingface.co"];
export const ENTRY_HOSTS = new Set([
  "github.com", "www.github.com", "raw.githubusercontent.com", "api.github.com",
  "codeload.github.com", "github.githubassets.com", "gist.github.com",
  "download.docker.com", "huggingface.co", "cdn-lfs.hf.co",
]);
const METHODS = new Set(["GET", "HEAD"]);

function isAllowedHost(hostname) {
  const host = hostname.toLowerCase();
  return HOSTS.has(host) || HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

export function githubTargetFromRequest(url) {
  let raw = url.pathname.slice(1);
  try {
    raw = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "GitHub URL 编码无效");
  }
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  return raw + url.search;
}

export function parseGithubTarget(input) {
  let target;
  try {
    target = new URL(input);
  } catch {
    throw new HttpError(400, "请输入有效的 GitHub URL");
  }
  if (target.protocol !== "https:" || !isAllowedHost(target.hostname)) {
    throw new HttpError(400, "仅支持已配置的 HTTPS 上游资源");
  }
  if (target.hostname === "www.github.com") target.hostname = "github.com";
  const blob = target.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (target.hostname === "github.com" && blob) {
    target.hostname = "raw.githubusercontent.com";
    target.pathname = `/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}`;
  }
  return target;
}

export function githubRepository(target) {
  const parts = target.pathname.split("/").filter(Boolean);
  if (target.hostname === "api.github.com") {
    return parts[0] === "repos" && parts.length >= 3 ? `${parts[1]}/${parts[2]}` : "";
  }
  if (target.hostname === "huggingface.co") {
    const offset = parts[0] === "spaces" ? 1 : 0;
    return parts.length >= offset + 2 ? `${parts[offset]}/${parts[offset + 1]}` : "";
  }
  if (target.hostname === "github.com" || target.hostname === "raw.githubusercontent.com" || target.hostname === "codeload.github.com" || target.hostname === "gist.github.com") {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : "";
  }
  return "";
}

export async function proxyGithub(request, env = {}) {
  if (request.method === "OPTIONS") return preflight("GET, HEAD, OPTIONS");
  if (!METHODS.has(request.method)) throw new HttpError(405, "资源代理仅支持 GET 和 HEAD");

  const requestUrl = new URL(request.url);
  const forceDownload = requestUrl.searchParams.get("__flarehub_download") === "1";
  requestUrl.searchParams.delete("__flarehub_download");
  let target = parseGithubTarget(githubTargetFromRequest(requestUrl));
  const downloadFilename = target.pathname.split("/").filter(Boolean).at(-1) || "download";
  enforceAccess(githubRepository(target), env, "上游资源");
  const headers = upstreamHeaders(request.headers);
  headers.delete("cookie");
  headers.delete("origin");
  headers.delete("referer");
  headers.set("user-agent", "FlareHub/0.1 (+https://workers.cloudflare.com)");
  headers.set("accept-language", "en-US");
  const cf = request.headers.has("authorization") ? undefined : cacheOptions(request, 3600);

  let response;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    response = await fetchUpstream(target, {
      method: request.method, headers, redirect: "manual", ...(cf ? { cf } : {}),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) break;
    const previousHost = target.hostname;
    target = parseGithubTarget(new URL(location, target).href);
    enforceAccess(githubRepository(target), env, "上游资源");
    if (target.hostname !== previousHost) headers.delete("authorization");
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) throw new HttpError(502, "GitHub 重定向次数过多");
  const result = downstreamResponse(response, { cors: true });
  if (request.headers.has("authorization")) {
    result.headers.set("cache-control", "private, no-store");
    result.headers.append("vary", "authorization");
  }
  if (forceDownload) {
    const fallback = downloadFilename.replace(/["\\\r\n]/g, "_");
    result.headers.set("content-disposition", `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(downloadFilename)}`);
    result.headers.set("x-content-type-options", "nosniff");
  }
  return result;
}
