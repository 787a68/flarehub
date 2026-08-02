'use strict';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const ALLOWED_HOSTS = new Set([
  'github.com', 'www.github.com', 'raw.githubusercontent.com', 'api.github.com',
  'codeload.github.com', 'github.githubassets.com', 'gist.github.com',
  'download.docker.com', 'huggingface.co', 'cdn-lfs.hf.co',
]);
const frontendConfig = globalThis.FLAREHUB_CONFIG || {};
const accessPolicy = {
  whitelist: Array.isArray(frontendConfig.whitelist) ? frontendConfig.whitelist : [],
  blacklist: Array.isArray(frontendConfig.blacklist) ? frontendConfig.blacklist : [],
  caseInsensitive: frontendConfig.caseInsensitive === true,
};

function keywordAllowed(value) {
  const normalize = (item) => accessPolicy.caseInsensitive ? String(item).toLowerCase() : String(item);
  const target = normalize(value || '');
  const whitelist = accessPolicy.whitelist.map(normalize).filter(Boolean);
  const blacklist = accessPolicy.blacklist.map(normalize).filter(Boolean);
  if (blacklist.some((keyword) => target.includes(keyword))) return false;
  return whitelist.length === 0 || whitelist.some((keyword) => target.includes(keyword));
}

function renderPolicyChips(targetId, values, emptyText) {
  const target = $(targetId);
  target.replaceChildren();
  if (!values.length) {
    const empty = document.createElement('code');
    empty.className = 'muted';
    empty.textContent = emptyText;
    target.append(empty);
    return;
  }
  values.forEach((value) => {
    const chip = document.createElement('code');
    chip.textContent = value;
    target.append(chip);
  });
}

function renderAccessPolicy() {
  renderPolicyChips('whitelistChips', accessPolicy.whitelist, '未设置（允许全部）');
  renderPolicyChips('blacklistChips', accessPolicy.blacklist, '未设置');
  $('policyMatchMode').textContent = `关键词包含匹配，${accessPolicy.caseInsensitive ? '忽略' : '区分'}大小写`;
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制');
  } catch {
    showToast('复制失败');
  }
}

function switchView(name) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
  document.querySelectorAll('.nav-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name));
  history.replaceState(null, '', `#${name}`);
  window.scrollTo(0, 0);
}

document.querySelectorAll('.nav-tab').forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.view)));

function formatGithubLink() {
  let link = $('githubLinkInput').value.trim();
  if (!link) return showToast('请输入链接');
  if (!/^https?:\/\//i.test(link)) link = `https://${link}`;
  let target;
  try {
    target = new URL(link);
  } catch {
    return showToast('链接格式错误');
  }
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname.toLowerCase())) return showToast('请输入支持的 HTTPS 上游链接');
  if (!keywordAllowed(`${target.hostname}${target.pathname}`)) return showToast('该资源不符合访问规则');
  $('githubFormattedLink').textContent = `${location.origin}/${link}`;
  $('githubOutput').classList.remove('hidden');
}

$('proxyForm').addEventListener('submit', (event) => {
  event.preventDefault();
  formatGithubLink();
});
$('pasteConvertButton').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) return showToast('剪贴板中没有链接');
    $('githubLinkInput').value = text.trim();
    formatGithubLink();
  } catch {
    $('githubLinkInput').focus();
    showToast('无法读取剪贴板，请粘贴链接后按回车');
  }
});
$('copyButton').addEventListener('click', () => copy($('githubFormattedLink').textContent));
$('openButton').addEventListener('click', () => window.open($('githubFormattedLink').textContent, '_blank', 'noopener'));

const host = location.host;
$('usageExamples').innerHTML = [
  ['GitHub Release', `https://${host}/github.com/user/repo/releases/download/v1.0/file.zip`],
  ['GitHub Archive', `https://${host}/github.com/user/repo/archive/refs/tags/v1.0.tar.gz`],
  ['GitHub Codeload', `https://${host}/codeload.github.com/user/repo/zip/refs/heads/master`],
  ['GitHub Raw', `https://${host}/raw.githubusercontent.com/user/repo/main/file.go`],
  ['GitHub Blob（自动转 Raw）', `https://${host}/github.com/user/repo/blob/main/file.go`],
  ['GitHub Gist', `https://${host}/gist.github.com/user/gist_id/raw`],
  ['GitHub API', `https://${host}/api.github.com/repos/user/repo/releases`],
  ['GitHub Assets', `https://${host}/github.githubassets.com/assets/123.js`],
  ['Docker 官方镜像', `docker pull ${host}/nginx`],
  ['Docker 用户镜像', `docker pull ${host}/user/image`],
  ['GHCR 镜像', `docker pull ${host}/ghcr.io/user/image`],
  ['GCR 镜像', `docker pull ${host}/gcr.io/project/image`],
  ['Quay.io 镜像', `docker pull ${host}/quay.io/org/image`],
  ['Kubernetes 镜像', `docker pull ${host}/registry.k8s.io/pause:3.9`],
  ['Docker 二进制', `https://${host}/download.docker.com/linux/static/stable/x86_64/docker.tgz`],
  ['Hugging Face', `https://${host}/huggingface.co/user/model/resolve/main/file.bin`],
  ['HF Spaces', `https://${host}/huggingface.co/spaces/user/space/resolve/main/app.py`],
  ['HF CDN', `https://${host}/cdn-lfs.hf.co/user/model/file.bin`],
].map(([title, code]) => `<div class="example"><strong>${title}</strong><code>${esc(code)}</code></div>`).join('');

let searchItems = [];
let searchPage = 1;
let searchQuery = '';
let searchSort = 'relevance';
let searchHasNext = false;
$('searchButton').addEventListener('click', search);
$('searchInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') search(); });
$('searchSort').addEventListener('change', () => search());
$('backToSearch').addEventListener('click', () => {
  $('tagList').innerHTML = '';
  $('searchResults').classList.remove('hidden');
  $('backToSearch').classList.add('hidden');
});

async function search(options = {}) {
  const append = Boolean(options.append);
  const query = $('searchInput').value.trim();
  const sort = $('searchSort').value;
  if (!query) return showToast('请输入搜索关键词');
  if (!append || query !== searchQuery || sort !== searchSort) {
    searchQuery = query;
    searchSort = sort;
    searchPage = 1;
    searchItems = [];
  }
  setLoading(true);
  $('tagList').innerHTML = '';
  $('backToSearch').classList.add('hidden');
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&page=${searchPage}&page_size=25`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `搜索失败 (${response.status})`);
    let results = (data.results || []).filter((item) => keywordAllowed(item.repo_name || item.name || ''));
    if (searchSort === 'pulls') results = [...results].sort((a, b) => Number(b.pull_count || 0) - Number(a.pull_count || 0));
    if (searchSort === 'name') results = [...results].sort((a, b) => String(a.repo_name || a.name || '').localeCompare(String(b.repo_name || b.name || '')));
    searchItems = append ? searchItems.concat(results) : results;
    searchHasNext = Boolean(data.next);
    const total = Number(data.count || searchItems.length);
    $('searchResults').innerHTML = searchItems.length ? `<div class="results-header">已显示 ${searchItems.length}${total ? ` / ${total}` : ''} 条结果</div>${searchItems.map((item, index) => {
      const name = item.repo_name || item.name || '';
      return `<button class="result-card" data-index="${index}"><span class="result-title">${esc(name)}</span><span class="result-desc">${esc(item.short_description || '暂无描述')}</span><span class="result-meta">${item.is_official ? '官方镜像 · ' : ''}${Number(item.pull_count || 0).toLocaleString()} 次拉取</span></button>`;
    }).join('')}${searchHasNext ? '<button class="btn btn-ghost load-more" id="loadMoreSearch" type="button">加载更多</button>' : ''}` : '<div class="empty">未找到相关镜像</div>';
  } catch (error) {
    if (!append) $('searchResults').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    else showToast(error.message);
  } finally {
    setLoading(false);
  }
}

$('searchResults').addEventListener('click', (event) => {
  const loadMore = event.target.closest('#loadMoreSearch');
  if (loadMore && searchHasNext) {
    searchPage += 1;
    search({ append: true });
    return;
  }
  const card = event.target.closest('.result-card');
  if (card) loadTags(searchItems[Number(card.dataset.index)]);
});

async function loadTags(item) {
  let image = item.repo_name || item.name || '';
  if (!image.includes('/')) image = `library/${image}`;
  setLoading(true);
  try {
    const response = await fetch(`/api/tags?image=${encodeURIComponent(image)}&page_size=100`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '标签查询失败');
    const tags = data.results || [];
    $('tagList').innerHTML = `<div class="card glass tag-header"><div class="tag-title">${esc(image)}</div><div class="card-desc">最近更新的 ${tags.length} 个标签</div></div>${tags.map((tag) => {
      const command = `docker pull ${host}/${image}:${tag.name}`;
      return `<div class="tag-item glass"><div class="tag-name">${esc(tag.name)}</div><div class="cmd-box">${esc(command)}<button class="btn btn-ghost btn-sm cmd-copy" data-copy="${esc(command)}">复制</button></div></div>`;
    }).join('') || '<div class="empty">暂无标签</div>'}`;
    $('searchResults').classList.add('hidden');
    $('backToSearch').classList.remove('hidden');
    window.scrollTo(0, 0);
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(false);
  }
}

$('tagList').addEventListener('click', (event) => {
  const button = event.target.closest('.cmd-copy');
  if (button) copy(button.dataset.copy);
});

function setLoading(loading) {
  $('searchLoading').classList.toggle('hidden', !loading);
}

let hfItems = [];
let hfCursor = '';
let hfQuery = '';
let hfSort = 'relevance';
let hfHasNext = false;
$('hfSearchButton').addEventListener('click', () => searchModels());
$('hfSearchInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') searchModels(); });
$('hfSearchSort').addEventListener('change', () => searchModels());
$('backToModels').addEventListener('click', () => {
  $('hfFiles').innerHTML = '';
  $('hfResults').classList.remove('hidden');
  $('backToModels').classList.add('hidden');
});

async function searchModels(options = {}) {
  const append = Boolean(options.append);
  const query = $('hfSearchInput').value.trim();
  const sort = $('hfSearchSort').value;
  if (!query) return showToast('请输入模型关键词');
  if (!append || query !== hfQuery || sort !== hfSort) {
    hfQuery = query;
    hfSort = sort;
    hfCursor = '';
    hfItems = [];
  }
  setHfLoading(true);
  $('hfFiles').innerHTML = '';
  $('backToModels').classList.add('hidden');
  try {
    const cursor = append && hfCursor ? `&cursor=${encodeURIComponent(hfCursor)}` : '';
    const response = await fetch(`/api/hf/search?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(hfSort)}&limit=30${cursor}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `模型搜索失败 (${response.status})`);
    const results = (data.results || []).filter((item) => keywordAllowed(item.id || ''));
    hfItems = append ? hfItems.concat(results) : results;
    hfCursor = data.next || '';
    hfHasNext = Boolean(hfCursor);
    $('hfResults').innerHTML = hfItems.length ? `<div class="results-header">已显示 ${hfItems.length} 个公开模型</div><div class="image-grid">${hfItems.map((item, index) => `<button class="image-card" data-index="${index}" type="button"><div class="image-name">${esc(item.id)}</div><p>${esc(item.pipeline_tag || '未标注任务类型')}</p><div class="image-meta"><span>${Number(item.downloads || 0).toLocaleString()} 次下载</span><span>${Number(item.likes || 0).toLocaleString()} 个赞</span></div></button>`).join('')}</div>${hfHasNext ? '<button class="btn btn-ghost load-more" id="loadMoreModels" type="button">加载更多</button>' : ''}` : '<div class="empty">未找到相关模型</div>';
  } catch (error) {
    if (!append) $('hfResults').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    else showToast(error.message);
  } finally {
    setHfLoading(false);
  }
}

$('hfResults').addEventListener('click', (event) => {
  const loadMore = event.target.closest('#loadMoreModels');
  if (loadMore && hfHasNext) {
    searchModels({ append: true });
    return;
  }
  const card = event.target.closest('.image-card');
  if (card) loadModelFiles(hfItems[Number(card.dataset.index)]?.id);
});

async function loadModelFiles(repo) {
  if (!repo) return;
  setHfLoading(true);
  try {
    const response = await fetch(`/api/hf/files?repo=${encodeURIComponent(repo)}&revision=main`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '获取模型文件失败');
    const files = data.files || [];
    const cliCommand = `hf download ${repo} --local-dir ${repo.split('/').pop() || 'model'}`;
    $('hfFiles').innerHTML = `<div class="card glass compact"><div class="card-title">${esc(repo)}</div><div class="card-desc">main 分支 · ${files.length} 个文件</div><div class="cmd-box model-download-command">${esc(cliCommand)}<button class="btn btn-ghost btn-sm copy-hf-link" data-copy-command="${esc(cliCommand)}" type="button">复制整仓下载命令</button></div><div class="card-desc">模型通常包含大文件，浏览器端打包易超出 Workers 内存与时限；使用 Hugging Face CLI 可断点续传并完整下载。</div></div><div class="file-list">${files.map((file) => {
      const filename = file.name.split('/').pop() || 'download';
      const downloadUrl = `${file.url}${file.url.includes('?') ? '&' : '?'}__flarehub_download=1`;
      return `<div class="file-item"><div><strong>${esc(file.name)}</strong><span>${formatBytes(file.size)}</span></div><div class="inline-actions"><button class="btn btn-ghost btn-sm copy-hf-link" data-url="${esc(downloadUrl)}" type="button">复制链接</button><a class="btn btn-primary btn-sm" href="${esc(downloadUrl)}" download="${esc(filename)}">下载</a></div></div>`;
    }).join('') || '<div class="empty">该仓库暂无文件</div>'}</div>`;
    $('hfResults').classList.add('hidden');
    $('backToModels').classList.remove('hidden');
    window.scrollTo(0, 0);
  } catch (error) {
    showToast(error.message);
  } finally {
    setHfLoading(false);
  }
}

$('hfFiles').addEventListener('click', (event) => {
  const button = event.target.closest('.copy-hf-link');
  if (!button) return;
  if (button.dataset.copyCommand) copy(button.dataset.copyCommand);
  else copy(new URL(button.dataset.url, location.origin).href);
});

function formatBytes(value) {
  const size = Number(value || 0);
  if (!size) return '大小未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  return `${(size / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function setHfLoading(loading) {
  $('hfLoading').classList.toggle('hidden', !loading);
}

function initialize() {
  const initialView = location.hash.slice(1);
  if (initialView === 'search' || initialView === 'models') switchView(initialView);
  renderAccessPolicy();
  formatGithubLink();
}

initialize();
