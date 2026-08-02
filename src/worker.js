import { publicAccessConfig } from "./access.js";
import { searchImages, listTags } from "./dockerhub.js";
import { ENTRY_HOSTS, proxyGithub } from "./github.js";
import { huggingFaceFiles, searchHuggingFace } from "./huggingface.js";
import { downloadDockerImage } from "./image-download.js";
import { HttpError, json, preflight } from "./http.js";
import { proxyRegistry, proxyRegistryToken } from "./registry.js";

export { accessAllowed, matchWildcard } from "./access.js";
export { githubRepository, githubTargetFromRequest, parseGithubTarget } from "./github.js";
export { parseRegistryRequest, registryConfig, registryRepository } from "./registry.js";

export default {
  async fetch(request, env = {}) {
    try {
      return await route(request, env);
    } catch (error) {
      const upstreamFailure = error instanceof TypeError;
      const status = error instanceof HttpError ? error.status : upstreamFailure ? 502 : 500;
      const message = status === 500 ? "服务器内部错误" : upstreamFailure ? "上游服务暂时不可达" : error.message;
      const headers = status === 429 ? { "retry-after": "60" } : undefined;
      const response = json({ error: message }, status);
      response.headers.set("access-control-allow-origin", "*");
      if (headers) for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
      return response;
    }
  },
};

async function enforceRateLimit(request, env) {
  if (!env.RATE_LIMITER) return;
  const url = new URL(request.url);
  const actor = request.headers.get("cf-connecting-ip") || "anonymous";
  const group = url.pathname.startsWith("/api/") ? "api" : "proxy";
  const { success } = await env.RATE_LIMITER.limit({ key: `${actor}:${group}` });
  if (!success) throw new HttpError(429, "请求过于频繁，请稍后再试");
}

async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    const methods = url.pathname === "/v2" || url.pathname.startsWith("/v2/")
      ? "GET, HEAD, PUT, POST, PATCH, DELETE, OPTIONS"
      : "GET, HEAD, OPTIONS";
    return preflight(methods);
  }
  if (url.pathname === "/api/config") return json({ access: publicAccessConfig(env) });

  await enforceRateLimit(request, env);
  if (url.pathname === "/api/search") return searchImages(request, env);
  if (url.pathname === "/api/tags") return listTags(request, env);
  if (url.pathname === "/api/hf/search") return searchHuggingFace(request, env);
  if (url.pathname === "/api/hf/files") return huggingFaceFiles(request, env);
  if (url.pathname === "/api/image/download") return downloadDockerImage(request, env);
  if (url.pathname === "/token") return proxyRegistryToken(request, env);
  if (url.pathname === "/v2" || url.pathname.startsWith("/v2/")) return proxyRegistry(request, env);
  if (isGithubProxyPath(url.pathname)) return proxyGithub(request, env);
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response("Not found", { status: 404 });
}

function isGithubProxyPath(pathname) {
  const candidate = pathname.slice(1).replace(/^https?:\/\//i, "");
  return ENTRY_HOSTS.has(candidate.split("/", 1)[0].toLowerCase());
}
