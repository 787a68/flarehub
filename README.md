# FlareHub

FlareHub 是部署在 Cloudflare Workers 上的资源代理，提供 GitHub、Hugging Face、Docker Hub 和常用 OCI Registry 的加速访问。项目自带可选 Web 前端，也可以只部署代理 Worker。

## 功能

- 转换并代理 GitHub Release、Raw、Archive、Codeload、Gist、API 和静态资源链接。
- 搜索 Hugging Face 公开模型，查看文件并生成代理下载链接。
- 搜索 Docker Hub 公开镜像，查看标签和支持的平台。
- 将 Docker Hub 镜像按指定平台导出为 OCI Image Layout tar。
- 代理 Docker Hub、GHCR、GCR、Quay 和 Kubernetes Registry 的 OCI Distribution API。
- 支持通过 Registry Basic/Bearer 鉴权拉取私有镜像。
- 支持仓库白名单、黑名单和按客户端 IP 分类限速。
- 支持 GitHub Actions 自动部署，Fork 后无需修改代码。

## 使用方法

以下示例假设服务地址为：

```text
https://flarehub.example.workers.dev
```

### 资源链接代理

代理格式为：

```text
https://你的服务域名/上游主机/资源路径
```

上游地址中的 `https://` 不保留。例如：

```text
# GitHub Release
https://flarehub.example.workers.dev/github.com/owner/repo/releases/download/v1.0/file.zip

# GitHub Raw
https://flarehub.example.workers.dev/raw.githubusercontent.com/owner/repo/main/file.txt

# Hugging Face
https://flarehub.example.workers.dev/huggingface.co/owner/model/resolve/main/model.safetensors
```

部署前端后，也可以打开服务首页，粘贴完整的上游 HTTPS 链接并自动转换。

资源代理仅接受代码内允许的 GitHub、Hugging Face 和 Docker 下载主机，不是任意 URL 开放代理。

### Docker 镜像拉取

Docker Hub 官方镜像：

```bash
docker pull flarehub.example.workers.dev/library/nginx:latest
```

Docker Hub 用户镜像：

```bash
docker pull flarehub.example.workers.dev/owner/image:tag
```

其他 Registry 需要将上游域名放在镜像路径首段：

```bash
docker pull flarehub.example.workers.dev/ghcr.io/owner/image:tag
docker pull flarehub.example.workers.dev/gcr.io/project/image:tag
docker pull flarehub.example.workers.dev/quay.io/owner/image:tag
docker pull flarehub.example.workers.dev/registry.k8s.io/pause:latest
```

当前固定支持以下 Registry：

- `docker.io`
- `registry-1.docker.io`
- `ghcr.io`
- `gcr.io`
- `quay.io`
- `registry.k8s.io`

上游映射固定在代码中，不能通过环境变量改成任意 Registry。

### 私有镜像

先使用上游 Registry 的用户名和密码或访问令牌登录 FlareHub 域名：

```bash
docker login flarehub.example.workers.dev
```

然后使用前述代理镜像地址执行 `docker pull`。例如拉取 GHCR 私有镜像时，在 `docker login` 中输入 GitHub 用户名和具备镜像读取权限的 Personal Access Token，再执行：

```bash
docker pull flarehub.example.workers.dev/ghcr.io/owner/private-image:tag
```

Docker 会通过 FlareHub 完成 Registry challenge 和 Token Service 交换。认证请求和令牌响应使用私有、禁止缓存的响应策略。

同一个代理域名在 Docker 客户端中只保存一组登录凭据。切换到使用不同凭据的上游 Registry 前，请重新执行 `docker login`。

### Web 前端

启用前端后提供三个功能页：

1. 资源链接转换和常用代理示例。
2. Docker Hub 镜像搜索、标签查询、拉取命令复制和 OCI tar 下载。
3. Hugging Face 公开模型搜索、文件查看和下载。

OCI tar 下载接口仅面向 Docker Hub 镜像，格式如下：

```text
/api/image/download?image=library/nginx:latest&platform=linux/amd64
```

## GitHub Actions 部署

### 1. Fork 仓库

Fork 本仓库后，无需修改 `wrangler.jsonc`。GitHub Actions 会根据仓库 Variables 生成临时部署配置。

### 2. 创建 Cloudflare API Token

登录 Cloudflare Dashboard，进入 API Token 管理页面并创建自定义 Token。

Token 使用以下最小权限：

| 权限范围 | 权限名称 | 访问级别 |
| --- | --- | --- |
| Account | Workers Scripts | Edit |

在 **Account Resources** 中只选择准备部署 FlareHub 的 Cloudflare 账户。无需添加 Zone、DNS、账户管理或其他无关权限。

创建后立即复制 Token。Cloudflare 只会完整显示一次。Token 必须保存为 GitHub Actions Secret，不能放入普通 Variable、仓库文件、Issue 或日志。

### 3. 获取 Cloudflare Account ID

在 Cloudflare Dashboard 对应账户页面复制 `Account ID`。它用于指定部署目标，本项目统一将其保存为 GitHub Actions Secret。

### 4. 配置 GitHub Actions

进入 Fork 仓库：

```text
Settings → Secrets and variables → Actions
```

在 **Secrets** 中添加：

| 名称 | 必填 | 说明 |
| --- | --- | --- |
| `CF_API_TOKEN` | 是 | 具有 `Account → Workers Scripts → Edit` 权限的 Cloudflare API Token |

在 **Variables** 中添加：

| 名称 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `CF_ACCOUNT_ID` | 是 | 无 | 目标 Cloudflare Account ID |
| `DEPLOY_FRONTEND` | 否 | `true` | `true` 部署前端；`false` 只部署 Worker |
| `WHITELIST` | 否 | 空 | 允许访问的仓库规则，支持逗号或换行分隔 |
| `BLACKLIST` | 否 | 空 | 禁止访问的仓库规则，支持逗号或换行分隔，优先于白名单 |
| `RATE_LIMITER` | 否 | `120` | 每个客户端 IP、每类请求每分钟允许的最大次数，必须为正整数 |

白名单和黑名单支持 `*` 通配符，例如：

```text
owner/*
owner/repository
```

未设置 `WHITELIST` 表示默认允许所有仓库。`BLACKLIST` 始终优先。

`RATE_LIMITER` 仓库 Variable 会在部署前写入 Cloudflare Rate Limiting binding 的 `limit`，周期固定为 60 秒。它不是 Worker 中的普通字符串变量。

### 5. 选择是否部署前端

- 未设置 `DEPLOY_FRONTEND` 或设为 `true`：部署 Worker 和 `public/` 前端，并创建 `ASSETS` binding。
- 设为 `false`：只部署 Worker，不上传 `public/`。代理、API 和 Registry 路由正常工作，其他页面路径返回 `404`。

### 6. 开始部署

进入：

```text
Actions → Deploy to Cloudflare Workers → Run workflow
```

也可以向 `main` 分支推送提交触发部署。

每次工作流都会：

1. 使用当时最新的稳定版 Node.js。
2. 根据 `package.json` 安装当时最新的兼容依赖，并额外安装最新版本的 Wrangler；不使用锁文件固定部署依赖版本。
3. 运行全部生产 JavaScript 文件的语法检查，失败时停止部署。
4. 将 `compatibility_date` 设置为部署当天的 UTC 日期。
5. 将仓库 Variables 写入临时 Wrangler 配置。
6. 使用最新 Wrangler 部署名为 `flarehub` 的 Worker。

Cloudflare Token 只注入配置检查和最终部署步骤，不会提供给依赖安装或测试步骤。工作流不会修改或提交 `wrangler.jsonc`、`package-lock.json` 和仓库代码。

## 本地开发

要求 Node.js 22 或更高版本。

```bash
npm install
npm run check
npm run dev
```

本地部署：

```bash
npm run deploy
```

本地部署检查：

```bash
npx wrangler deploy --dry-run
```

本地命令直接使用 `wrangler.jsonc`。自动更新依赖和当天 `compatibility_date` 的行为仅用于 GitHub Actions 部署。

## 配置说明

`wrangler.jsonc` 包含以下配置：

- Worker 名称固定为 `flarehub`。
- `WHITELIST` 和 `BLACKLIST` 是运行时字符串 Variables。
- `RATE_LIMITER` 是 Cloudflare Rate Limiting binding，默认限制为每分钟 120 次。
- `ASSETS` 是可选静态资源 binding，只在部署前端时存在。

Registry 上游地址是 `src/registry.js` 中的固定安全映射。以下名称不是有效环境变量，无需在 GitHub 或 Cloudflare 中设置：

- `DOCKER_REGISTRY`
- `GHCR_REGISTRY`
- `GCR_REGISTRY`
- `QUAY_REGISTRY`
- `K8S_REGISTRY`

## 安全说明

- 仅允许代理预先配置的 HTTPS 主机和 Registry。
- Cookie、Origin、Referer、逐跳请求头和 Cloudflare 内部请求头不会转发给资源上游。
- GitHub 跨主机重定向不会携带原始 Authorization。
- Registry 认证请求及 `401` 响应禁止公共缓存。
- 白名单和黑名单在 Worker 服务端执行。
- Cloudflare API Token 遵循最小权限原则，并仅保存于 GitHub Secret。
