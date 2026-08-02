import { enforceAccess } from "./access.js";
import { clampInt, fetchUpstream, HttpError, json, preflight } from "./http.js";

function safeRepoId(value, env = {}) {
  const repo = String(value || "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new HttpError(400, "模型仓库格式应为 owner/name");
  enforceAccess(repo, env, "Hugging Face 仓库");
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
  const upstream = new URL("https://huggingface.co/api/models");
  upstream.searchParams.set("search", query);
  upstream.searchParams.set("sort", "downloads");
  upstream.searchParams.set("direction", "-1");
  upstream.searchParams.set("limit", String(limit));

  const response = await fetchUpstream(upstream, { headers: { accept: "application/json" } });
  if (!response.ok) throw new HttpError(response.status, "Hugging Face 搜索失败");

  const models = await response.json();
  const results = [];
  for (const model of Array.isArray(models) ? models : []) {
    const id = model.id || model.modelId;
    try {
      safeRepoId(id, env);
      if (!model.private) results.push(modelSummary(model));
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 403) throw error;
    }
  }
  return json({ results, count: results.length });
}

export async function huggingFaceFiles(request, env = {}) {
  const input = new URL(request.url);
  const repo = safeRepoId(input.searchParams.get("repo"), env);
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
