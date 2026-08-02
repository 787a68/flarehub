import { accessAllowed, enforceAccess } from "./access.js";
import { clampInt, fetchUpstream, HttpError, json, preflight } from "./http.js";

function safeRepoId(value) {
  const repo = String(value || "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new HttpError(400, "模型仓库格式应为 owner/name");
  return repo;
}

function modelSummary(model) {
  return {
    id: model.id || model.modelId,
    author: model.author || "",
    pipeline_tag: model.pipeline_tag || "",
    downloads: Number(model.downloads || 0),
    likes: Number(model.likes || 0),
    lastModified: model.lastModified || "",
    private: Boolean(model.private),
  };
}

export async function searchHuggingFace(request, env = {}) {
  const input = new URL(request.url);
  const query = (input.searchParams.get("q") || "").trim();
  if (!query) throw new HttpError(400, "请输入模型关键词");

  const limit = clampInt(input.searchParams.get("limit"), 1, 30, 12);
  const sort = (input.searchParams.get("sort") || "downloads").trim();
  const allowedSorts = new Set(["relevance", "downloads", "likes", "lastModified"]);
  if (!allowedSorts.has(sort)) throw new HttpError(400, "不支持的模型排序方式");
  const upstream = new URL("https://huggingface.co/api/models");
  upstream.searchParams.set("search", query);
  if (sort !== "relevance") {
    upstream.searchParams.set("sort", sort);
    upstream.searchParams.set("direction", "-1");
  }
  upstream.searchParams.set("limit", String(limit));
  const cursor = (input.searchParams.get("cursor") || "").trim();
  if (cursor) upstream.searchParams.set("cursor", cursor);

  const response = await fetchUpstream(upstream, { headers: { accept: "application/json" } });
  if (!response.ok) throw new HttpError(response.status, "Hugging Face 搜索失败");

  const models = await response.json();
  const results = (Array.isArray(models) ? models : [])
    .filter((model) => !model.private && /^[\w.-]+\/[\w.-]+$/.test(model.id || model.modelId || ""))
    .filter((model) => accessAllowed(model.id || model.modelId || "", env))
    .map(modelSummary);
  return json({ results, count: results.length, next: nextCursor(response.headers.get("link")) });
}

function nextCursor(link) {
  if (!link) return "";
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (!match) continue;
    try {
      return new URL(match[1]).searchParams.get("cursor") || "";
    } catch {
      return "";
    }
  }
  return "";
}

export async function huggingFaceFiles(request, env = {}) {
  const input = new URL(request.url);
  const repo = safeRepoId(input.searchParams.get("repo"));
  enforceAccess(repo, env, "Hugging Face 仓库");
  const revision = (input.searchParams.get("revision") || "main").trim();
  if (!/^[\w./-]+$/.test(revision) || revision.includes("..")) throw new HttpError(400, "无效的模型版本");

  const upstream = new URL(`https://huggingface.co/api/models/${repo}/revision/${encodeURIComponent(revision)}`);
  upstream.searchParams.set("blobs", "true");
  const response = await fetchUpstream(upstream, { headers: { accept: "application/json" } });
  if (!response.ok) throw new HttpError(response.status, "获取模型文件失败");

  const model = await response.json();
  const files = (model.siblings || []).map(file => ({
    name: file.rfilename,
    size: Number(file.size || file.lfs?.size || 0),
    lfs: Boolean(file.lfs),
    url: `/huggingface.co/${repo}/resolve/${revision}/${file.rfilename.split("/").map(encodeURIComponent).join("/")}`,
  }));
  return json({ repo, revision, files });
}

export function hfOptions() {
  return preflight("GET, HEAD, OPTIONS");
}
