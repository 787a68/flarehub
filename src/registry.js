import { enforceAccess } from "./access.js";
import { addCors, cacheOptions, cleanHeaders, downstreamResponse, fetchUpstream, HttpError, preflight, upstreamHeaders } from "./http.js";

const METHODS = new Set(["GET", "HEAD", "PUT", "POST", "PATCH", "DELETE"]);

export function registryConfig() {
  return {
    "docker.io": { upstream: "registry-1.docker.io", authHost: "https://auth.docker.io/token" },
    "registry-1.docker.io": { upstream: "registry-1.docker.io", authHost: "https://auth.docker.io/token" },
    "ghcr.io": { upstream: "ghcr.io", authHost: "https://ghcr.io/token" },
    "quay.io": { upstream: "quay.io", authHost: "https://quay.io/v2/auth" },
    "gcr.io": { upstream: "gcr.io", authHost: "https://gcr.io/v2/token" },
    "registry.k8s.io": { upstream: "registry.k8s.io", authHost: "https://registry.k8s.io/v2/token" },
  };
}

export function parseRegistryRequest(url, config) {
  const segments = url.pathname.replace(/^\/v2\/?/, "").split("/").filter(Boolean);
  const namespace = (url.searchParams.get("ns") || "").toLowerCase();
  let registry = config[namespace] ? namespace : "docker.io";
  if (segments.length && config[segments[0].toLowerCase()]) registry = segments.shift().toLowerCase();
  if (registry === "docker.io" || registry === "registry-1.docker.io") {
    const marker = segments.findIndex((part) => ["manifests", "blobs", "tags", "referrers"].includes(part));
    if (marker === 1) segments.unshift("library");
  }
  return { registry, upstreamPath: segments.join("/") };
}

export function registryRepository(upstreamPath) {
  const parts = upstreamPath.split("/").filter(Boolean);
  const marker = parts.findIndex((part) => ["manifests", "blobs", "tags", "referrers"].includes(part));
  return marker > 0 ? parts.slice(0, marker).join("/") : "";
}

export async function proxyRegistry(request, env = {}) {
  if (request.method === "OPTIONS") return preflight("GET, HEAD, PUT, POST, PATCH, DELETE, OPTIONS");
  if (!METHODS.has(request.method)) throw new HttpError(405, "不支持此请求方法");

  const incoming = new URL(request.url);
  const config = registryConfig();
  const parsed = parseRegistryRequest(incoming, config);
  enforceAccess(registryRepository(parsed.upstreamPath), env, "Docker 镜像");
  const registry = config[parsed.registry];
  const target = new URL(`https://${registry.upstream}/v2/${parsed.upstreamPath}`);
  target.search = incoming.search;
  target.searchParams.delete("ns");

  const headers = upstreamHeaders(request.headers);
  headers.delete("cookie");
  headers.delete("origin");
  headers.delete("referer");
  headers.set("host", registry.upstream);
  const response = await fetchUpstream(target, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "manual",
    cf: cacheOptions(request, /\/blobs\//.test(target.pathname) ? 604800 : 300),
  });
  const responseHeaders = cleanHeaders(response.headers);
  const authenticated = request.headers.has("authorization");
  if (authenticated || response.status === 401) {
    responseHeaders.set("cache-control", "private, no-store");
    responseHeaders.append("vary", "authorization");
  }
  const challenge = responseHeaders.get("www-authenticate");
  if (challenge) responseHeaders.set("www-authenticate", rewriteAuthChallenge(challenge, incoming, parsed.registry));
  const location = responseHeaders.get("location");
  if (location) {
    const redirect = new URL(location, target);
    if (redirect.protocol === "https:" && redirect.hostname === registry.upstream) {
      responseHeaders.set("location", `${incoming.origin}/v2/${parsed.registry}/${redirect.pathname.replace(/^\/v2\//, "")}${redirect.search}`);
    }
  }
  addCors(responseHeaders);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
}

function rewriteAuthChallenge(challenge, incoming, registry) {
  return challenge.replace(/realm="([^"]+)"/i, (_, realm) => {
    const token = new URL("/token", incoming.origin);
    token.searchParams.set("registry", registry);
    token.searchParams.set("realm", realm);
    return `realm="${token.href}"`;
  });
}

export async function proxyRegistryToken(request, env) {
  if (request.method === "OPTIONS") return preflight("GET, HEAD, OPTIONS");
  if (!new Set(["GET", "HEAD"]).has(request.method)) throw new HttpError(405, "令牌接口仅支持 GET 和 HEAD");
  const incoming = new URL(request.url);
  for (const scope of incoming.searchParams.getAll("scope")) {
    const match = scope.match(/^repository:([^:]+):/i);
    if (match) enforceAccess(match[1], env, "Docker 镜像");
  }
  const config = registryConfig();
  const registryName = (incoming.searchParams.get("registry") || "docker.io").toLowerCase();
  const registry = config[registryName];
  if (!registry) throw new HttpError(400, "未知 Registry");
  const configuredAuth = new URL(registry.authHost);
  const suppliedRealm = incoming.searchParams.get("realm");
  let target = configuredAuth;
  if (suppliedRealm) {
    const parsedRealm = new URL(suppliedRealm);
    if (parsedRealm.protocol !== "https:" || !new Set([configuredAuth.hostname, registry.upstream]).has(parsedRealm.hostname)) {
      throw new HttpError(400, "Registry 认证地址不受信任");
    }
    target = parsedRealm;
  }
  for (const [key, value] of incoming.searchParams) {
    if (!new Set(["registry", "realm"]).has(key)) target.searchParams.append(key, value);
  }
  const tokenHeaders = new Headers({ accept: "application/json", "user-agent": "FlareHub/0.1" });
  const authorization = request.headers.get("authorization");
  if (authorization) tokenHeaders.set("authorization", authorization);
  const response = await fetchUpstream(target, { method: request.method, headers: tokenHeaders, redirect: "manual" });
  return downstreamResponse(response, { cors: true, noStore: true });
}
