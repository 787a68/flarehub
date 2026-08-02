import { accessAllowed, enforceAccess } from "./access.js";
import { addCors, clampInt, downstreamResponse, fetchUpstream, HttpError } from "./http.js";

export async function searchImages(request, env) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const page = clampInt(url.searchParams.get("page"), 1, 100, 1);
  const pageSize = clampInt(url.searchParams.get("page_size"), 1, 100, 25);
  if (!query) throw new HttpError(400, "搜索关键词不能为空");

  const target = new URL("https://hub.docker.com/v2/search/repositories/");
  target.searchParams.set("query", query);
  target.searchParams.set("page", String(page));
  target.searchParams.set("page_size", String(pageSize));
  const response = await fetchUpstream(target, {
    headers: { accept: "application/json", "user-agent": "FlareHub/0.1" },
    cf: { cacheEverything: true, cacheTtl: 300, cacheTtlByStatus: { "200-299": 300, "400-499": 0, "500-599": 0 } },
  });
  if (!response.ok) return downstreamResponse(response, { cors: true });
  const data = await response.json();
  data.results = (data.results || []).filter((item) => accessAllowed(item.repo_name || item.name || "", env));
  const headers = new Headers(response.headers);
  headers.set("cache-control", "public, max-age=60");
  addCors(headers);
  return new Response(JSON.stringify(data), { status: response.status, headers });
}

export async function listTags(request, env = {}) {
  const url = new URL(request.url);
  let image = (url.searchParams.get("image") || "").trim().replace(/^docker\.io\//, "");
  if (!image) throw new HttpError(400, "镜像名称不能为空");
  if (!image.includes("/")) image = `library/${image}`;
  if (!/^[a-z0-9._/-]+$/i.test(image) || image.includes("..")) throw new HttpError(400, "镜像名称无效");
  enforceAccess(image, env, "Docker 镜像");

  const page = clampInt(url.searchParams.get("page"), 1, 100, 1);
  const pageSize = clampInt(url.searchParams.get("page_size"), 1, 100, 25);
  const target = new URL(`https://hub.docker.com/v2/repositories/${image}/tags/`);
  target.searchParams.set("page", String(page));
  target.searchParams.set("page_size", String(pageSize));
  target.searchParams.set("ordering", "last_updated");
  const response = await fetchUpstream(target, {
    headers: { accept: "application/json", "user-agent": "FlareHub/0.1" },
    cf: { cacheEverything: true, cacheTtl: 300, cacheTtlByStatus: { "200-299": 300, "400-499": 0, "500-599": 0 } },
  });
  return downstreamResponse(response, { cors: true });
}
