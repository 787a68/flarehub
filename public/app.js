const byId = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const formatNumber = value => new Intl.NumberFormat("zh-CN", { notation: "compact" }).format(Number(value || 0));
const formatBytes = value => {
  const bytes = Number(value || 0);
  if (!bytes) return "未知大小";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** power)).toFixed(power ? 1 : 0)} ${units[power]}`;
};

const state = { policy: { whitelist: [], blacklist: [] }, dockerResults: [], hfResults: [] };
const ALLOWED_HOSTS = new Set([
  "github.com", "api.github.com", "raw.githubusercontent.com", "codeload.github.com", "github.githubassets.com",
  "gist.github.com", "download.docker.com", "huggingface.co", "cdn-lfs.hf.co"
]);

function showToast(message, type = "success") {
  const toast = byId("toast");
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = "toast"; }, 2300);
}

async function api(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

function wildcard(value, pattern) {
  const source = String(pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${source}$`, "i").test(value);
}

function policyIdentity(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "huggingface.co" && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  if (["github.com", "api.github.com", "raw.githubusercontent.com", "codeload.github.com", "objects.githubusercontent.com", "gist.github.com", "gist.githubusercontent.com"].includes(url.hostname) && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return "";
}

function isAllowedUpstream(url) {
  return url.protocol === "https:" && (!url.port || url.port === "443") && ALLOWED_HOSTS.has(url.hostname);
}

function validatePolicy(identity) {
  if (!identity) return;
  if (state.policy.blacklist.some(rule => wildcard(identity, rule))) throw new Error(`仓库 ${identity} 已被加入黑名单`);
  if (state.policy.whitelist.length && !state.policy.whitelist.some(rule => wildcard(identity, rule))) throw new Error(`仓库 ${identity} 不在白名单中`);
}

function proxyUrl(input) {
  const source = input.trim();
  if (!source) throw new Error("请先粘贴或输入资源链接");
  let url;
  try { url = new URL(source); } catch { throw new Error("请输入完整的 HTTPS 链接"); }
  if (!isAllowedUpstream(url)) throw new Error("当前仅支持页面列出的 GitHub、Docker 下载与 Hugging Face 主机");
  validatePolicy(policyIdentity(url));
  return `${location.origin}/${url.hostname}${url.pathname}${url.search}${url.hash}`;
}

function switchView(view) {
  document.querySelectorAll(".nav-tab").forEach(tab => tab.classList.toggle("active", tab.dataset.view === view));
  document.querySelectorAll(".view").forEach(panel => panel.classList.toggle("active", panel.id === `view-${view}`));
}

document.querySelectorAll(".nav-tab").forEach(tab => tab.addEventListener("click", () => switchView(tab.dataset.view)));

function renderProxyLink() {
  try {
    const output = proxyUrl(byId("githubLinkInput").value);
    byId("githubFormattedLink").textContent = output;
    byId("githubOutput").classList.remove("hidden");
    return true;
  } catch (error) {
    byId("githubOutput").classList.add("hidden");
    showToast(error.message, "error");
    return false;
  }
}

byId("proxyForm").addEventListener("submit", event => {
  event.preventDefault();
  renderProxyLink();
});

byId("pasteConvertButton").addEventListener("click", async () => {
  const button = byId("pasteConvertButton");
  try {
    button.disabled = true;
    let text = byId("githubLinkInput").value.trim();
    if (!text) {
      if (!navigator.clipboard?.readText) throw new Error("当前浏览器不支持读取剪贴板，请手动粘贴链接");
      text = (await navigator.clipboard.readText()).trim();
      if (!text) throw new Error("剪贴板中没有可转换的链接");
      byId("githubLinkInput").value = text;
    }
    if (renderProxyLink()) showToast("链接已转换");
  } catch (error) {
    const clipboardDenied = error.name === "NotAllowedError" || error.message === "Read permission denied";
    showToast(clipboardDenied ? "无法读取剪贴板，请手动粘贴链接" : error.message, "error");
    byId("githubLinkInput").focus();
  } finally {
    button.disabled = false;
  }
});

byId("copyButton").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(byId("githubFormattedLink").textContent); showToast("链接已复制"); }
  catch { showToast("复制失败，请手动复制", "error"); }
});
byId("openButton").addEventListener("click", () => window.open(byId("githubFormattedLink").textContent, "_blank", "noopener,noreferrer"));

const host = location.host;
const base = location.origin;
const examples = [
  ["GitHub Release", `${base}/github.com/owner/repo/releases/download/v1.0/file.zip`], ["GitHub Archive", `${base}/github.com/owner/repo/archive/refs/heads/main.zip`],
  ["GitHub Codeload", `${base}/codeload.github.com/owner/repo/zip/refs/heads/main`], ["GitHub Raw", `${base}/raw.githubusercontent.com/owner/repo/main/README.md`],
  ["GitHub Blob", `${base}/github.com/owner/repo/blob/main/README.md`], ["GitHub Gist", `${base}/gist.github.com/owner/id`],
  ["GitHub API", `${base}/api.github.com/repos/owner/repo/releases/latest`], ["GitHub Assets", `${base}/github.githubassets.com/assets/example.css`],
  ["Docker 官方镜像", `docker pull ${host}/library/nginx:latest`], ["Docker 用户镜像", `docker pull ${host}/owner/image:tag`],
  ["GitHub Container", `docker pull ${host}/ghcr.io/owner/image:tag`], ["Google Container", `docker pull ${host}/gcr.io/project/image:tag`],
  ["Quay", `docker pull ${host}/quay.io/owner/image:tag`], ["Kubernetes", `docker pull ${host}/registry.k8s.io/pause:latest`],
  ["Docker 二进制", `${base}/download.docker.com/linux/static/stable/x86_64/docker.tgz`], ["HF 模型", `${base}/huggingface.co/owner/model/resolve/main/model.safetensors`],
  ["HF Spaces", `${base}/huggingface.co/spaces/owner/app/resolve/main/file`], ["HF CDN", `${base}/cdn-lfs.hf.co/path/to/file`]
];
byId("usageExamples").innerHTML = examples.map(([title, value]) => `<div class="usage-row"><span class="usage-badge">${esc(title)}</span><code>${esc(value)}</code></div>`).join("");

async function loadPolicy() {
  try {
    const data = await api("/api/config");
    state.policy = data.access || state.policy;
    const list = (title, values, empty) => `<div class="policy-item"><strong>${title}</strong>${values.length ? `<div class="chips">${values.map(value => `<code>${esc(value)}</code>`).join("")}</div>` : `<span>${empty}</span>`}</div>`;
    byId("policyContent").innerHTML = list("白名单", state.policy.whitelist, "未启用，默认允许") + list("黑名单", state.policy.blacklist, "未配置");
  } catch (error) { byId("policyContent").innerHTML = `<div class="empty compact">${esc(error.message)}</div>`; }
}

byId("dockerSearchForm").addEventListener("submit", event => { event.preventDefault(); searchDocker(); });
async function searchDocker() {
  const query = byId("searchInput").value.trim();
  if (!query) return showToast("请输入镜像关键词", "error");
  byId("searchLoading").classList.remove("hidden"); byId("searchResults").innerHTML = ""; byId("tagList").innerHTML = "";
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(query)}&page_size=24`);
    state.dockerResults = data.results || [];
    byId("searchResults").innerHTML = state.dockerResults.length ? `<div class="results-header"><span>找到 ${state.dockerResults.length} 个镜像</span></div><div class="image-grid">${state.dockerResults.map((item, index) => `<button class="image-card" data-docker-index="${index}" type="button"><div class="image-name">${esc(item.repo_name || item.name)}</div><p>${esc(item.short_description || item.description || "暂无描述")}</p><div class="image-meta"><span>下载 ${formatNumber(item.pull_count)}</span><span>收藏 ${formatNumber(item.star_count)}</span></div></button>`).join("")}</div>` : '<div class="empty">未找到镜像</div>';
  } catch (error) { byId("searchResults").innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
  finally { byId("searchLoading").classList.add("hidden"); }
}
byId("searchResults").addEventListener("click", event => { const card = event.target.closest("[data-docker-index]"); if (card) showTags(state.dockerResults[Number(card.dataset.dockerIndex)].name); });

async function showTags(repository) {
  byId("searchResults").innerHTML = ""; byId("backToSearch").classList.remove("hidden"); byId("searchLoading").classList.remove("hidden");
  try {
    const data = await api(`/api/tags?image=${encodeURIComponent(repository)}&page_size=50`);
    const tags = (data.results || []).map(tag => ({
      ...tag,
      size: Math.max(0, ...(tag.images || []).map(image => Number(image.size || 0))),
      platforms: [...new Set((tag.images || []).filter(image => image.os && image.architecture).map(image => `${image.os}/${image.architecture}${image.variant ? `/${image.variant}` : ""}`))],
    }));
    byId("tagList").innerHTML = `<div class="results-header"><span>${esc(repository)} · ${tags.length} 个标签</span></div><div class="tag-list">${tags.map((tag, index) => {
      const platforms = Array.isArray(tag.platforms) && tag.platforms.length ? tag.platforms : ["linux/amd64"];
      return `<div class="tag-item"><div class="tag-top"><div><span class="tag-name">${esc(tag.name)}</span><span class="tag-size">${formatBytes(tag.size)}</span></div><button class="btn btn-ghost btn-sm" data-copy-pull="${esc(repository)}:${esc(tag.name)}" type="button">复制拉取命令</button></div><div class="download-row"><select class="select" id="platform-${index}">${platforms.map(platform => `<option value="${esc(platform)}">${esc(platform)}</option>`).join("")}</select><button class="btn btn-primary btn-sm" data-image-download="${esc(repository)}:${esc(tag.name)}" data-platform-select="platform-${index}" type="button">下载 OCI 归档</button></div></div>`;
    }).join("")}</div>`;
  } catch (error) { byId("tagList").innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
  finally { byId("searchLoading").classList.add("hidden"); }
}
byId("backToSearch").addEventListener("click", () => { byId("backToSearch").classList.add("hidden"); byId("tagList").innerHTML = ""; searchDocker(); });
byId("tagList").addEventListener("click", async event => {
  const copy = event.target.closest("[data-copy-pull]");
  if (copy) { await navigator.clipboard.writeText(`docker pull ${location.host}/${copy.dataset.copyPull}`); return showToast("拉取命令已复制"); }
  const download = event.target.closest("[data-image-download]");
  if (download) {
    const platform = byId(download.dataset.platformSelect).value;
    location.href = `/api/image/download?image=${encodeURIComponent(download.dataset.imageDownload)}&platform=${encodeURIComponent(platform)}`;
  }
});

byId("hfSearchForm").addEventListener("submit", event => { event.preventDefault(); searchModels(); });
async function searchModels() {
  const query = byId("hfSearchInput").value.trim();
  if (!query) return showToast("请输入模型关键词", "error");
  byId("hfLoading").classList.remove("hidden"); byId("hfResults").innerHTML = ""; byId("hfFiles").innerHTML = "";
  try {
    const data = await api(`/api/hf/search?q=${encodeURIComponent(query)}&limit=24`);
    state.hfResults = data.results || [];
    byId("hfResults").innerHTML = state.hfResults.length ? `<div class="results-header"><span>找到 ${state.hfResults.length} 个模型</span></div><div class="image-grid">${state.hfResults.map((model, index) => `<button class="image-card" data-hf-index="${index}" type="button"><div class="image-name">${esc(model.id)}</div><p>${esc(model.pipeline_tag || "未标注任务类型")}</p><div class="image-meta"><span>下载 ${formatNumber(model.downloads)}</span><span>喜欢 ${formatNumber(model.likes)}</span></div></button>`).join("")}</div>` : '<div class="empty">未找到公开模型</div>';
  } catch (error) { byId("hfResults").innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
  finally { byId("hfLoading").classList.add("hidden"); }
}
byId("hfResults").addEventListener("click", event => { const card = event.target.closest("[data-hf-index]"); if (card) showModelFiles(state.hfResults[Number(card.dataset.hfIndex)].id); });
async function showModelFiles(repo) {
  byId("hfResults").innerHTML = ""; byId("backToModels").classList.remove("hidden"); byId("hfLoading").classList.remove("hidden");
  try {
    const data = await api(`/api/hf/files?repo=${encodeURIComponent(repo)}`);
    byId("hfFiles").innerHTML = `<div class="results-header"><span>${esc(repo)} · ${data.files.length} 个文件</span></div><div class="file-list">${data.files.map(file => `<div class="file-item"><div><strong>${esc(file.name)}</strong><span>${formatBytes(file.size)}</span></div><div class="inline-actions"><button class="btn btn-ghost btn-sm" data-copy-url="${esc(location.origin + file.url)}" type="button">复制链接</button><a class="btn btn-primary btn-sm" href="${esc(file.url)}">下载</a></div></div>`).join("")}</div>`;
  } catch (error) { byId("hfFiles").innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
  finally { byId("hfLoading").classList.add("hidden"); }
}
byId("backToModels").addEventListener("click", () => { byId("backToModels").classList.add("hidden"); byId("hfFiles").innerHTML = ""; searchModels(); });
byId("hfFiles").addEventListener("click", async event => { const button = event.target.closest("[data-copy-url]"); if (button) { await navigator.clipboard.writeText(button.dataset.copyUrl); showToast("下载链接已复制"); } });

loadPolicy();
