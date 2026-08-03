# FlareHub

基于 Cloudflare Workers 的轻量级边缘代理，一站式加速 GitHub 资源、Docker 镜像与 Hugging Face 模型文件。

## 功能

| 功能 | 说明 |
|------|------|
| **GitHub 代理** | Releases、Raw、Blob（自动转 Raw）、Archive、Codeload、Gist、API、Assets |
| **Docker Registry 镜像** | `docker.io`、`ghcr.io`、`gcr.io`、`quay.io`、`registry.k8s.io` |
| **Docker 镜像下载** | 一键下载 Docker 镜像为 `.tar` 文件 |
| **Hugging Face 代理** | 模型文件、Spaces、CDN-LFS |
| **访问控制** | 支持白名单/黑名单，关键词匹配，可配大小写敏感 |
| **速率限制** | 可配置的请求频率限制 |

## 快速使用

在资源原始 URL 前加上本站专属域名即可：

```
原始链接: https://raw.githubusercontent.com/user/repo/main/file.go
代理链接: https://你的域名/raw.githubusercontent.com/user/repo/main/file.go
```

### GitHub 资源

```bash
# Release 下载
https://你的域名/github.com/787a68/flarehub/releases/download/v1.0/file.zip

# Archive 下载
https://你的域名/github.com/user/repo/archive/refs/tags/v1.0.tar.gz

# Codeload 下载
https://你的域名/codeload.github.com/user/repo/zip/refs/heads/main

# Raw 文件
https://你的域名/raw.githubusercontent.com/user/repo/main/file.go

# Blob 页面（自动转为 Raw 下载）
https://你的域名/github.com/user/repo/blob/main/file.go

# Gist Raw
https://你的域名/gist.github.com/user/gist_id/raw

# API 请求
https://你的域名/api.github.com/repos/user/repo/releases

# Assets 静态资源
https://你的域名/github.githubassets.com/assets/123.js
```

### Docker 镜像拉取

```bash
# Docker Hub 官方镜像
docker pull 你的域名/nginx:latest
docker pull 你的域名/library/alpine:3.20

# Docker Hub 用户镜像
docker pull 你的域名/username/image:tag

# GitHub Container Registry
docker pull 你的域名/ghcr.io/user/image:tag

# Google Container Registry
docker pull 你的域名/gcr.io/project/image:tag

# Quay.io
docker pull 你的域名/quay.io/org/image:tag

# Kubernetes Registry
docker pull 你的域名/registry.k8s.io/pause:3.9
```

### Docker 镜像下载（浏览器一键下载 .tar）

```
https://你的域名/api/image/download?image=library/alpine:latest&platform=linux/amd64
```

参数说明：
- `image`：镜像名称（必填），格式 `<repo>[:<tag>]`，默认 tag 为 `latest`
- `platform`：目标架构，默认 `linux/amd64`，可选如 `linux/arm64`

### Hugging Face 模型文件

```bash
# 模型文件
https://你的域名/huggingface.co/user/model-name/resolve/main/file.bin

# Spaces 文件
https://你的域名/huggingface.co/spaces/user/space/resolve/main/app.py

# CDN-LFS 文件
https://你的域名/cdn-lfs.hf.co/user/model/file.bin
```

### Docker 二进制下载

```bash
# Docker 官方二进制
https://你的域名/download.docker.com/linux/static/stable/x86_64/docker-27.0.0.tgz
```

## 本地开发

### 前置要求

- [Node.js](https://nodejs.org/) >= 18
- npm >= 9

### 安装与运行

```bash
# 克隆仓库
git clone https://github.com/787a68/flarehub.git
cd flarehub

# 安装依赖
npm install

# 启动本地开发服务器
npx wrangler dev
```

启动后本地地址通常为 `http://localhost:8787`，你可以使用此行测试：

```bash
curl -v http://localhost:8787/raw.githubusercontent.com/787a68/flarehub/main/README.md
```

### 运行测试

```bash
npm test
# 或者直接
node --test test/
```

### 检查配置

```bash
npm run check
```

此命令会校验 `wrangler.jsonc` 的配置完整性。

### 项目结构

```
flarehub/
├── public/                  # 前端静态资源
│   ├── index.html           # 主页面
│   ├── app.js               # 前端交互逻辑
│   ├── app.css              # 样式（毛玻璃设计，自动适配暗色模式）
│   ├── config.js            # 部署时自动生成的运行时配置（.gitignore）
│   └── favicon.svg
├── src/                     # Worker 源码
│   ├── worker.js            # 入口：路由分发
│   ├── github.js            # GitHub / HF / Docker 二进制代理
│   ├── registry.js          # Docker Registry v2 代理 + Token
│   ├── image-download.js    # Docker 镜像 → tar 下载
│   ├── http.js              # HTTP 工具（错误处理、CORS、缓存等）
│   └── access.js            # 访问控制（白名单/黑名单）
├── scripts/
│   └── prepare-deploy.mjs   # 部署前配置生成脚本
├── test/                    # 测试文件
│   ├── worker.test.js       # Worker 路由和代理逻辑测试（16 个用例）
│   └── features.test.js     # 项目特性与配置完整性测试（9 个用例）
├── wrangler.jsonc           # Wrangler 配置
└── package.json
```

## 部署到 Cloudflare Workers

### 方式一：一键部署（推荐）

点击下方按钮自动 Fork 并部署到你的 Cloudflare 账户：

> 部署前需准备 Cloudflare 账户，并在该账户的 Dashboard 中创建一个 **API Token**（权限：Account → Workers Scripts → Edit）。

配置 GitHub Actions Secrets（仓库 Settings → Secrets and variables → Actions）：

| Secret | 说明 | 必填 |
|--------|------|------|
| `CF_API_TOKEN` | Cloudflare API Token | 是 |
| `CF_ACCOUNT_ID` | Cloudflare 账户 ID（Dashboard 右侧） | 是 |

配置 GitHub Actions Variables（可选）：

| Variable | 说明 | 默认值 |
|----------|------|--------|
| `WHITELIST` | 白名单，逗号分隔的关键词，如 `787a68/flarehub,library/` | 无（允许全部） |
| `BLACKLIST` | 黑名单，逗号分隔的关键词 | 无 |
| `CASE_INSENSITIVE` | 是否忽略大小写，`true` / `false` | `false` |
| `RATE_LIMITER` | 每分钟每 IP 请求上限（正整数） | 1000 |
| `DEPLOY_FRONTEND` | 是否部署前端页面，`true` / `false` | `true` |

推送代码到 `main` 分支即可自动部署。

### 方式二：手动部署

```bash
# 安装 Wrangler CLI
npm install -g wrangler

# 登录 Cloudflare
npx wrangler login

# 配置 wrangler.jsonc 中的 account_id 为你自己的账户 ID

# 部署
npm run deploy
```

### 方式三：本地构建后手动上传

```bash
# 生成部署配置文件到 .wrangler/deploy.jsonc
CF_ACCOUNT_ID=你的账户ID node scripts/prepare-deploy.mjs

# 部署
npx wrangler deploy --config .wrangler/deploy.jsonc
```

### 配置 Workers 变量

部署后，可在 Cloudflare Dashboard → Workers & Pages → flarehub → Settings → Variables 中配置以下变量（优先级高于 GH Variables）：

| 变量 | 说明 |
|------|------|
| `WHITELIST` | 白名单关键词，逗号分隔。为空则不限制 |
| `BLACKLIST` | 黑名单关键词，逗号分隔。黑名单优先级高于白名单 |
| `CASE_INSENSITIVE` | `true` 忽略大小写，`false` 区分大小写 |
| `RATE_LIMITER` | 绑定 KV 限速器，每分钟每 IP 请求上限 |

### 绑定自定义域名

1. 进入 Cloudflare Dashboard → Workers & Pages → flarehub
2. 点击 **Triggers** → **Custom Domains** → **Add Custom Domain**
3. 输入你的域名（如 `hub.example.com`）
4. Cloudflare 会自动配置 DNS（域名需在 Cloudflare 上管理）

### 使用 Docker 镜像加速

使用代理域名替换镜像源地址：

```bash
# 方式一：每次拉取时指定
docker pull hub.example.com/library/nginx:latest

# 方式二：配置 Docker daemon 全局代理（推荐）
# 编辑 /etc/docker/daemon.json（Linux）或 Docker Desktop Settings（Mac/Windows）
{
  "registry-mirrors": ["https://hub.example.com"]
}
# 重启 Docker 后即可直接 docker pull nginx:latest
```

> **注意**：当使用 `registry-mirrors` 方式时，`docker pull nginx:latest` 会自动走代理（仅 Docker Hub 官方镜像）。用户命名空间的镜像仍需手动指定域名。

## 访问控制详解

FlareHub 通过关键词匹配来控制代理访问范围：

- **白名单**：设置后，只有匹配白名单关键词的请求才会被代理。未设置则允许全部。
- **黑名单**：匹配黑名单的请求将被拒绝。黑名单优先级高于白名单。
- **匹配方式**：关键词包含匹配（子串匹配），默认区分大小写。
- **影响范围**：白名单/黑名单对 GitHub 代理、Docker Registry、Docker 镜像下载、Hugging Face 代理全部生效。

示例：

```
WHITELIST = "787a68/flarehub, library/, pytorch"
BLACKLIST = "private-repo, secret-model"
```

- `github.com/787a68/flarehub/releases/*` → 放行（匹配白名单 `787a68/flarehub`）
- `docker pull hub.example.com/library/nginx` → 放行（匹配白名单 `library/`）
- `huggingface.co/user/pytorch-model/resolve/*` → 放行（匹配白名单 `pytorch`）
- `github.com/user/private-repo/*` → 拒绝（匹配黑名单 `private-repo`）

## 技术栈

- **运行时**：Cloudflare Workers
- **前端**：原生 HTML/CSS/JS（毛玻璃设计，自动暗色模式适配，零依赖）
- **测试**：Node.js 原生 `node:test` + `assert`
- **部署**：GitHub Actions + Wrangler CLI

## License

[MIT](LICENSE)
