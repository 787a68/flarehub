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
  const proxyPath = `${target.hostname}${target.pathname}${target.search}${target.hash}`;
  $('githubFormattedLink').textContent = `https://${location.host}/${proxyPath}`;
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
$('downloadButton').addEventListener('click', () => {
  const proxyUrl = $('githubFormattedLink').textContent;
  let filename;
  try {
    const path = new URL(proxyUrl).pathname;
    // 取路径最后一段作为文件名
    filename = path.split('/').filter(Boolean).pop() || 'download';
  } catch {
    filename = 'download';
  }
  const a = document.createElement('a');
  a.href = proxyUrl;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast('开始下载');
});

renderAccessPolicy();

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
