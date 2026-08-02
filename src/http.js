export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

export function upstreamHeaders(source) {
  const headers = new Headers(source);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  for (const name of ["host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "x-forwarded-for", "x-forwarded-proto"]) {
    headers.delete(name);
  }
  return headers;
}

export function cleanHeaders(source) {
  const headers = new Headers(source);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  return headers;
}

export function cacheOptions(request, seconds) {
  if (request.method !== "GET" || request.headers.has("authorization")) return undefined;
  return { cacheEverything: true, cacheTtl: seconds, cacheTtlByStatus: { "200-299": seconds, "401": 0, "404": 30, "500-599": 0 } };
}

export async function fetchUpstream(target, init) {
  try {
    return await fetch(target, init);
  } catch {
    throw new HttpError(502, "上游服务暂时不可达");
  }
}

export function downstreamResponse(response, options = {}) {
  const headers = cleanHeaders(response.headers);
  if (options.cors) addCors(headers);
  if (options.noStore) headers.set("cache-control", "private, no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function addCors(headers) {
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "authorization, content-type, range");
  headers.set("access-control-expose-headers", "content-length,content-range,docker-content-digest,etag,location");
}

export function preflight(methods) {
  const headers = new Headers();
  addCors(headers);
  headers.set("access-control-allow-methods", methods);
  headers.set("access-control-max-age", "86400");
  return new Response(null, { status: 204, headers });
}

export function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
