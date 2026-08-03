# FlareHub

运行在 Cloudflare Workers 上的边缘加速代理，为 GitHub、Docker Registry 与 Hugging Face 提供全球边缘网络流式传输加速。无需服务器、无需数据库，部署后即可使用。

## 功能特性

- **GitHub 加速**：Release 下载、Archive 打包、Raw 文件、Codeload、API、Gist、静态资源
- **Docker Registry 代理**：支持 `docker pull` 直接拉取，兼容 Docker Hub、GHCR、Quay、GCR、registry.k8s.io
- **Hugging Face 加速**：resolve、blob、raw 文件及 CDN LFS 大文件
- **访问控制**：基于关键词的白名单 / 黑名单，黑名单优先
- **速率限制**：基于 Cloudflare Rate Limiter 的全局 IP 级请求限流（含 CORS 预检）
- **前端面板**：内置玻璃拟态 UI，提供链接转换器、访问规则展示与使用示例
- **CI/CD**：GitHub Actions 自动部署到 Cloudflare Workers，支持上游同步

## 支持的上游域名

| 类别 | 域名 |
|------|------|
| GitHub | `github.com`、`raw.githubusercontent.com`、`api.github.com`、`codeload.github.com`、`github.githubassets.com`、`gist.github.com`、`gist.githubusercontent.com` |
| Docker | `registry-1.docker.io`、`ghcr.io`、`quay.io`、`gcr.io`、`registry.k8s.io`、`download.docker.com` |
| Hugging Face | `huggingface.co`、`cdn-lfs.hf.co`、`cdn-lfs-us-1.hf.co` |

## 使用方法

### 基本格式

将上游资源地址拼接在本站域名之后即可：

```
https://flarehub.example.com/github.com/user/repo
```

也支持直接拼接完整 HTTPS 地址：

```
https://flarehub.example.com/https://github.com/user/repo
```

### GitHub 加速

| 场景 | 加速链接 |
|------|----------|
| Release 下载 | `https://flarehub.example.com/github.com/user/repo/releases/download/v1.0/file.zip` |
| Archive 打包 | `https://flarehub.example.com/github.com/user/repo/archive/refs/tags/v1.0.tar.gz` |
| Codeload | `https://flarehub.example.com/codeload.github.com/user/repo/zip/refs/heads/master` |
| Raw 文件 | `https://flarehub.example.com/raw.githubusercontent.com/user/repo/main/file.go` |
| Blob（自动转 Raw） | `https://flarehub.example.com/github.com/user/repo/blob/main/file.go` |
| Gist | `https://flarehub.example.com/gist.github.com/user/gist_id/raw` |
| API | `https://flarehub.example.com/api.github.com/repos/user/repo/releases` |
| 静态资源 | `https://flarehub.example.com/github.githubassets.com/assets/123.js` |

> 注意：GitHub、Hugging Face、Gist 的网页（HTML）不会被代理，仅代理文件、归档和 API 数据。

### Docker Registry 加速

直接将镜像源替换为你的域名即可使用 `docker pull`：

```bash
# Docker Hub 官方镜像
docker pull flarehub.example.com/nginx

# Docker Hub 用户镜像
docker pull flarehub.example.com/user/image

# GHCR 镜像
docker pull flarehub.example.com/ghcr.io/user/image

# GCR 镜像
docker pull flarehub.example.com/gcr.io/project/image

# Quay.io 镜像
docker pull flarehub.example.com/quay.io/org/image

# Kubernetes 镜像
docker pull flarehub.example.com/registry.k8s.io/pause:3.9
```

也可在 Docker daemon 配置中设为默认镜像源（`/etc/docker/daemon.json`）：

```json
{
  "registry-mirrors": ["https://flarehub.example.com"]
}
```

修改后重启 Docker：

```bash
sudo systemctl restart docker
```

### Hugging Face 加速

| 场景 | 加速链接 |
|------|----------|
| 模型文件 | `https://flarehub.example.com/huggingface.co/user/model/resolve/main/file.bin` |
| Spaces 文件 | `https://flarehub.example.com/huggingface.co/spaces/user/space/resolve/main/app.py` |
| CDN LFS | `https://flarehub.example.com/cdn-lfs.hf.co/user/model/file.bin` |

### Docker 二进制下载

```bash
curl -L -o docker.tgz "https://flarehub.example.com/download.docker.com/linux/static/stable/x86_64/docker.tgz"
```

## 部署方法

### 前置要求

- [Cloudflare](https://www.cloudflare.com/) 账户
- GitHub 仓库（用于 CI/CD 自动部署）

### GitHub Actions 自动部署

#### 1. Fork 或克隆仓库

```bash
git clone https://github.com/787a68/flarehub.git
cd flarehub
```

#### 2. 获取 Cloudflare 凭据

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 在首页右侧栏或任意 Workers 页面找到 **Account ID**，复制保存
3. 进入 **Workers & Pages** → 右上角点击头像 → **My Profile** → **API Tokens**
4. 点击 **Create Token**，选择 **Edit Cloudflare Workers** 模板
5. 确认权限包含：
   - Account - Workers Scripts - Edit
   - Account - Account Settings - Read
   - Zone - Zone - Read（如需绑定自定义域名）
6. 创建后复制 Token 值（仅显示一次）

#### 3. 配置 GitHub Secrets

在 GitHub 仓库 → **Settings** → **Secrets and variables** → **Actions** → **Secrets** 中添加：

| Secret 名称 | 值 |
|-------------|----|
| `CF_API_TOKEN` | 上一步创建的 Cloudflare API Token |
| `CF_ACCOUNT_ID` | 你的 Cloudflare Account ID |

#### 4. 配置 GitHub Variables（可选）

在同一页面的 **Variables** 标签中添加（均为可选）：

| Variable 名称 | 说明 | 默认值 |
|---------------|------|--------|
| `DEPLOY_FRONTEND` | 是否部署前端面板，`true` / `false` | `true` |
| `WHITELIST` | 白名单关键词，逗号分隔 | 空（允许全部） |
| `BLACKLIST` | 黑名单关键词，逗号分隔 | 空 |
| `CASE_INSENSITIVE` | 关键词匹配是否忽略大小写 | `false` |
| `RATE_LIMITER` | 每分钟请求限制数（正整数） | `120` |

示例：

```
WHITELIST = my-org, my-repo
BLACKLIST = private, internal
CASE_INSENSITIVE = true
RATE_LIMITER = 60
```

#### 5. 触发部署

推送到 `main` 分支即可自动部署，或在 GitHub 仓库 → **Actions** → **Deploy to Cloudflare Workers** 手动触发（`workflow_dispatch`）。

部署流程：
1. 检出代码并安装依赖
2. 运行 `npm run check` 语法检查
3. 执行 `scripts/prepare-deploy.mjs` 生成部署配置（注入环境变量）
4. 调用 `wrangler deploy` 部署到 Cloudflare Workers


## 配置说明

### `wrangler.jsonc` 核心字段

| 字段 | 说明 |
|------|------|
| `name` | Worker 名称，部署后决定 `*.workers.dev` 子域名 |
| `main` | Worker 入口文件，默认 `src/worker.js` |
| `compatibility_date` | 兼容性日期，影响运行时行为 |
| `assets` | 静态资源配置，部署时由 `prepare-deploy.mjs` 将 `public/` 复制到 `.wrangler/public/` 并内联配置，通过 `ASSETS` 绑定提供 |
| `assets.run_worker_first` | 这些路径优先由 Worker 处理，而非直接返回静态文件 |
| `assets.not_found_handling` | 静态资源 404 时返回 `404.html` 页面 |
| `ratelimits` | Rate Limiter 绑定，`namespace_id` 为限流命名空间 |
| `vars` | 环境变量默认值，可被 Cloudflare Dashboard / GitHub Variables 覆盖 |
| `placement.mode` | `smart` 表示由 Cloudflare 自动选择最优数据中心 |
| `observability` | 启用日志与可观测性 |

### 环境变量

| 变量 | 作用 | 示例 |
|------|------|------|
| `WHITELIST` | 仅允许匹配关键词的资源访问，逗号分隔 | `my-org, my-repo` |
| `BLACKLIST` | 拒绝匹配关键词的资源访问，黑名单优先 | `private, internal` |
| `CASE_INSENSITIVE` | 关键词匹配是否忽略大小写 | `true` / `false` |

> `RATE_LIMITER` 不是环境变量，而是 GitHub Variable，用于在部署时设置 Rate Limiter 绑定的请求阈值（每 60 秒每 IP 最大请求数）。

访问规则匹配逻辑：
- 对 GitHub 代理，匹配对象为 `owner/repo`
- 对 Docker Registry 代理，匹配对象为镜像仓库名
- 关键词为**包含匹配**：目标字符串包含关键词即命中
- 黑名单优先于白名单：命中黑名单则拒绝，无论白名单如何设置
- 白名单为空时允许全部（未被黑名单命中的）

### 在 Cloudflare Dashboard 修改配置

部署后可在 **Workers & Pages** → 选择 Worker → **Settings** → **Variables** 中直接修改环境变量。访问控制规则（白名单 / 黑名单）在 Worker 端实时读取，修改后立即生效，无需重新部署。前端面板的规则显示为部署时快照，需重新部署才会更新。

## 项目结构

```
flarehub/
├── src/
│   ├── worker.js          # Worker 入口，路由分发
│   ├── github.js          # GitHub / HuggingFace / Docker 二进制代理
│   ├── registry.js        # Docker Registry v2 代理与令牌转发
│   ├── access.js          # 白名单 / 黑名单访问控制
│   └── http.js            # HTTP 工具：CORS、错误、头清理、缓存
├── public/
│   ├── index.html         # 前端面板
│   ├── app.js             # 前端逻辑：链接转换、规则展示
│   ├── app.css            # 玻璃拟态样式
│   ├── favicon.svg         # 站点图标
│   └── 404.html           # 404 页面
├── scripts/
│   └── prepare-deploy.mjs # CI 部署前配置生成脚本
├── .github/workflows/
│   ├── deploy.yml         # Cloudflare Workers 自动部署
│   └── sync-upstream.yml  # 上游仓库每日同步
├── wrangler.jsonc         # Cloudflare Workers 配置
└── package.json
```

## 上游同步

仓库内置 `sync-upstream.yml` 工作流，启用后每日自动从上游 `787a68/flarehub` 同步更新：

- 无冲突时自动合并并推送
- 有冲突时自动创建 PR 供手动解决

## 常见问题

### 如何限制只代理特定仓库？

设置 `WHITELIST` 变量，匹配对象为 `owner/repo`（GitHub）或镜像名（Docker），关键词为**包含匹配**：

```
WHITELIST = my-org/my-repo, another-org
```

设置后，仅 `owner/repo` 或镜像名中包含关键词的资源会被允许访问，其余被拒绝。白名单为空时允许全部（未被黑名单命中的）。

> 注意：这是基于关键词的子串匹配，并非检测仓库的可见性。

### 如何按关键词屏蔽资源？

设置 `BLACKLIST` 变量，匹配对象为 `owner/repo`（GitHub）或镜像名（Docker），关键词为**包含匹配**：

```
BLACKLIST = private, internal
```

设置后，`owner/repo` 或镜像名中包含 `private` 或 `internal` 子串的资源会被拒绝访问。

> 注意：这是基于关键词的子串匹配，并非检测仓库的可见性。仓库名中不含这些关键词的私有仓库不会被拦截。

### 前端面板不显示访问规则？

访问规则在部署时内联到 `index.html` 中（`window.__FLAREHUB_CONFIG__`），无需额外 Worker 请求。修改 `WHITELIST` / `BLACKLIST` / `CASE_INSENSITIVE` 环境变量后，需要重新部署才能更新前端面板显示。注意：访问控制的实际执行在 Worker 端实时读取环境变量，修改后立即生效，无需重新部署。

### 如何关闭前端面板只保留代理功能？

设置 GitHub Variable `DEPLOY_FRONTEND=false`，部署脚本会移除 `assets` 配置，仅部署 Worker。

## 许可证

[MIT License](LICENSE)
