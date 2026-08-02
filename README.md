# FlareHub

部署在 Cloudflare Workers 上的代理服务，提供网页界面和 API，支持 GitHub、Hugging Face 与 OCI/Docker Registry 的代理访问、资源搜索和文件下载。

## 用法

以下示例中的 `<地址>` 是部署后的 Worker 主机名，例如 `flarehub.<你的子域>.workers.dev`。

### 部署前端时

`DEPLOY_FRONTEND` 默认为 `true`。打开 `https://<地址>`，可通过网页使用以下功能：

- 粘贴 GitHub、Hugging Face 或 Docker 官方下载链接并生成代理地址
- 搜索 Hugging Face 公开模型、浏览文件并下载
- 搜索 Docker Hub 镜像、查询标签、复制拉取命令或下载 OCI 归档

### 不部署前端时

设置 `DEPLOY_FRONTEND=false` 后只部署 Worker，不提供首页和搜索界面，代理路由与 API 保持可用。

资源代理地址的格式是 `https://<地址>/<原始地址去掉协议>`：

```text
https://<地址>/github.com/user/repo/releases/download/v1.0/file.zip
https://<地址>/raw.githubusercontent.com/user/repo/main/file.txt
https://<地址>/huggingface.co/user/model/resolve/main/file.bin
https://<地址>/download.docker.com/linux/static/stable/x86_64/docker.tgz
```

Hugging Face 文件地址增加 `?__flarehub_download=1` 可强制以附件形式下载：

```text
https://<地址>/huggingface.co/user/model/resolve/main/file.bin?__flarehub_download=1
```

Docker/OCI Registry 可直接通过部署地址拉取：

```text
docker pull <地址>/nginx:latest
docker pull <地址>/user/image:tag
docker pull <地址>/ghcr.io/user/image:tag
docker pull <地址>/quay.io/org/image:tag
docker pull <地址>/gcr.io/project/image:tag
docker pull <地址>/registry.k8s.io/pause:3.9
```

也可以直接调用下列 HTTP API。

### API

| 路径 | 用途 |
| --- | --- |
| `GET /api/search?q=nginx&page=1&page_size=25` | 搜索 Docker Hub 镜像 |
| `GET /api/tags?image=library/nginx&page_size=100` | 查询镜像标签 |
| `GET /api/hf/search?q=model&limit=30` | 搜索 Hugging Face 模型 |
| `GET /api/hf/files?repo=owner/model&revision=main` | 列举模型仓库文件 |
| `GET /api/image/download?...` | 下载 OCI 镜像归档 |
| `GET /token?...` | 转发 Registry Bearer Token |
| `/v2/*` | OCI/Docker Registry API v2 代理 |

### 错误路径

部署前端时，无效路径由 Static Assets 直接返回 `404.html`，不进入 Worker。纯 Worker 模式下，无效路径由 Worker 返回纯文本 `404`。

## 部署

### 前置条件

- Cloudflare 账户
- 一个 GitHub 账户（用于 Fork 仓库和 GitHub Actions）

### 1. Fork 仓库

Fork 本仓库到你的 GitHub 账户，进入 Fork 仓库的 **Actions** 页面，手动启用 GitHub Actions（Fork 后默认关闭）。

> 仓库包含 `Sync upstream` 工作流，用于自动同步原仓库更新。Fork 用户需在 Actions 页面手动启用该工作流，默认每天 UTC 06:06 运行一次，也支持手动触发。仅执行 fast-forward 合并，不覆盖 Fork 自有提交。

### 2. 获取 Cloudflare Account ID

Cloudflare Dashboard → **Account home**，找到账号行，点击末尾菜单选择 **Copy account ID**。或在 **Workers & Pages** 页面的 **Account details** 中点击复制。

### 3. 创建 API Token

Cloudflare Dashboard → **Manage Account → API Tokens**，选择 **Create Token**。可使用 **Edit Cloudflare Workers** 模板，或创建自定义 Token，权限至少包含 `Workers Scripts Write`。建议将 Token 资源范围限制到需要部署的账号。创建后立即复制 Token。

### 4. 配置 GitHub Secrets

Fork 仓库 → **Settings → Secrets and variables → Actions → Secrets**，添加：

| Secret | 必填 | 说明 |
| --- | --- | --- |
| `CF_API_TOKEN` | 是 | Cloudflare API Token |
| `CF_ACCOUNT_ID` | 是 | Cloudflare Account ID |

工作流会将这两个 Secret 映射为 Wrangler 环境变量 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 进行部署。

### 5. 配置 Variables

在同一页面切换到 **Variables**，按需添加：

| Variable | 默认值 | 说明 |
| --- | --- | --- |
| `DEPLOY_FRONTEND` | `true` | `false` 时不部署前端静态资源 |
| `RATE_LIMITER` | `120` | 同 IP 每分钟共享请求额度，正整数 |
| `WHITELIST` | 空 | 允许关键词，逗号分隔；空时允许所有 |
| `BLACKLIST` | 空 | 禁止关键词，逗号分隔；黑名单优先于白名单 |
| `CASE_INSENSITIVE` | `false` | `true` 时黑白名单匹配忽略大小写 |

黑白名单使用关键词包含匹配。默认区分大小写；设置 `CASE_INSENSITIVE=true` 后忽略大小写。部署脚本将此规则同步写入前端静态配置与 Worker 运行时。

### 6. 部署

进入 **Actions → Deploy to Cloudflare Workers → Run workflow**，选择 `main` 分支运行。之后推送 `main` 分支会自动触发部署。

## 运行规则

- **限速**：按客户端 IP 共享，默认每分钟 120 次。
- **黑白名单**：默认空，关键词包含匹配；黑名单优先。
- **缓存**：Docker Hub 搜索与标签响应使用短时边缘缓存，减少上游限流触发。
- **代理安全**：仅允许硬编码的受信任 HTTPS 主机；跨域重定向不携带客户端认证凭据。
- **Smart Placement**：已启用。
