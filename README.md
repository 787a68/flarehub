# FlareHub

FlareHub 是运行在 Cloudflare Workers 上的 GitHub、Hugging Face 和容器镜像代理。部署后可直接使用网页转换链接、搜索 Docker Hub 镜像、下载 OCI 镜像归档，以及搜索 Hugging Face 模型。

## 使用说明

将下文中的 `https://你的域名` 替换为部署后的 `workers.dev` 地址或绑定到 Worker 的自定义域名。

### 网页

访问：

```text
https://你的域名/
```

网页提供：

- GitHub、Hugging Face 等受支持链接的加速地址转换。
- Docker Hub 公共镜像搜索、标签浏览和 OCI 镜像归档下载。
- Hugging Face 公共模型搜索、文件浏览和加速链接生成。
- 当前仓库白名单、黑名单策略展示。

如果部署时将 `DEPLOY_FRONTEND` 设为 `false`，网页不会部署，但代理接口仍可使用。

### GitHub 文件

在原始 HTTPS 地址前添加 FlareHub 域名，并去掉原地址中的 `https://`：

```text
原地址：  https://github.com/owner/repo/releases/download/v1.0/file.zip
加速地址：https://你的域名/github.com/owner/repo/releases/download/v1.0/file.zip
```

同样的格式适用于以下主机：

- `github.com`
- `raw.githubusercontent.com`
- `gist.githubusercontent.com`
- `codeload.github.com`
- `objects.githubusercontent.com`
- `release-assets.githubusercontent.com`

例如：

```text
https://你的域名/raw.githubusercontent.com/owner/repo/main/file.txt
https://你的域名/codeload.github.com/owner/repo/zip/refs/heads/main
```

访问私有 GitHub 资源时，可向 FlareHub 请求传递原有的 `Authorization` 请求头。鉴权请求不会进入共享缓存。

### Hugging Face 文件

格式同样为“FlareHub 域名 + 上游主机 + 路径”：

```text
原地址：  https://huggingface.co/Qwen/Qwen2.5-0.5B/resolve/main/README.md
加速地址：https://你的域名/huggingface.co/Qwen/Qwen2.5-0.5B/resolve/main/README.md
```

支持：

- `huggingface.co`
- `cdn-lfs.huggingface.co`
- `cdn-lfs-us-1.huggingface.co`
- `cdn-lfs-eu-1.huggingface.co`

### 容器镜像代理

支持以下 Registry：

| 上游 | FlareHub 路径前缀 |
| --- | --- |
| Docker Hub | `/docker.io` |
| GitHub Container Registry | `/ghcr.io` |
| Google Container Registry | `/gcr.io` |
| Quay | `/quay.io` |
| Kubernetes Registry | `/registry.k8s.io` |

拉取 Docker Hub 官方 `library/alpine`：

```bash
docker pull 你的域名/library/alpine:latest
```

也可以显式保留 Registry 前缀：

```bash
docker pull 你的域名/docker.io/library/alpine:latest
docker pull 你的域名/ghcr.io/owner/image:tag
docker pull 你的域名/gcr.io/project/image:tag
docker pull 你的域名/quay.io/owner/image:tag
docker pull 你的域名/registry.k8s.io/pause:3.10
```

私有镜像先登录 FlareHub 域名，再执行拉取：

```bash
docker login 你的域名
docker pull 你的域名/ghcr.io/owner/private-image:tag
```

FlareHub 会把 Registry 的认证请求代理到对应上游，不保存用户名、密码或上游 Token。

### 下载 Docker Hub 镜像为 OCI 归档

```text
https://你的域名/api/image-download?image=alpine:latest&platform=linux/amd64
```

参数：

- `image`：Docker Hub 镜像及可选标签；未指定标签时使用 `latest`。
- `platform`：可选，默认为 `linux/amd64`，也支持带 variant 的格式，例如 `linux/arm/v7`。

下载结果为 OCI Image Layout 的 `.tar` 文件，只支持 Docker Hub 镜像。

## 部署说明

### 1. Fork 仓库

Fork 本仓库。在 Fork 仓库的 **Actions** 页面启用 GitHub Actions。

工作流会在以下情况部署：

- 推送到 `main` 分支。
- 在 **Actions → Deploy to Cloudflare Workers → Run workflow** 手动运行。

### 2. 获取 Cloudflare Account ID

`CF_ACCOUNT_ID` 必须是目标 Cloudflare **账户 ID**，不是域名的 Zone ID。按 Cloudflare 文档操作：

1. 登录 Cloudflare Dashboard。
2. 打开 **Workers & Pages**。
3. 在 **Account details** 中复制 **Account ID**。

也可以在 **Account home** 找到目标账户，打开账户行末尾的菜单，选择 **Copy account ID**。

### 3. 创建 Cloudflare API Token

按 Cloudflare 的 Workers GitHub Actions 与 API Token 文档操作：

1. 登录 Cloudflare Dashboard。
2. 打开 **My Profile → API Tokens**。
3. 点击 **Create Token**。
4. 在 **API token templates** 中找到 **Edit Cloudflare Workers**，点击 **Use template**。
5. 配置 Token 的账户资源，使其包含 `CF_ACCOUNT_ID` 对应的目标账户。
6. 点击 **Continue to summary** 检查 Token 权限和资源范围。
7. 点击 **Create Token**。
8. 立即复制生成的 Token Secret。

Token Secret 只显示一次。不要将其以明文保存到他人可访问的位置；任何获得该 Token 的人都可以对其授权资源执行相应操作。

### 4. 配置 GitHub Secrets

打开 Fork 仓库：

**Settings → Secrets and variables → Actions → Secrets → New repository secret**

添加：

| 名称 | 值 |
| --- | --- |
| `CF_API_TOKEN` | 上一步复制的 Cloudflare API Token Secret |
| `CF_ACCOUNT_ID` | 目标 Cloudflare 账户的 Account ID |

两个值都必须放在 **Secrets** 中。工作流会把它们传给 Wrangler，并把 Account ID 显式写入临时部署配置。

### 5. 配置可选 GitHub Variables

在以下位置添加：

**Settings → Secrets and variables → Actions → Variables → New repository variable**

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `DEPLOY_FRONTEND` | `true` | `false` 时不部署 `public/` 前端，只部署代理 Worker |
| `WHITELIST` | 空 | 允许访问的仓库，多个值用逗号分隔 |
| `BLACKLIST` | 空 | 禁止访问的仓库，多个值用逗号分隔，优先级高于白名单 |
| `RATE_LIMITER` | `120` | 每个客户端 IP 每 60 秒允许的请求数，必须为正整数 |

访问规则格式：

```text
owner/repo,another-owner/*
```

- `owner/repo`：匹配单个仓库或镜像仓库。
- `owner/*`：匹配该所有者下的全部仓库。
- 白名单为空时默认允许所有仓库。
- 黑名单始终优先。

### 6. 运行部署

配置完成后，可向 `main` 推送提交，或手动运行部署工作流。

每次 Actions 部署会：

1. 获取 `main` 分支代码。
2. 使用当时最新的稳定版 Node.js。
3. 安装 `package.json` 范围内的最新兼容依赖，并额外安装最新版 Wrangler；部署不使用锁文件固定依赖版本。
4. 运行生产 JavaScript 文件的语法检查。
5. 将 `compatibility_date` 设置为部署当天的 UTC 日期。
6. 根据 GitHub Variables 生成临时 Wrangler 配置。
7. 使用 `CF_API_TOKEN` 和 `CF_ACCOUNT_ID` 部署名为 `flarehub` 的 Worker。

部署完成后，在 Cloudflare Dashboard 的 **Workers & Pages** 中打开 `flarehub`，即可查看 `workers.dev` 地址或配置自定义域名。

### 认证错误排查

如果 Actions 出现 `Authentication error [code: 10000]`，依次确认：

1. `CF_API_TOKEN` 保存的是创建完成时只显示一次的 Token Secret，没有额外引号或空格。
2. Token 使用 **Edit Cloudflare Workers** 模板创建。
3. Token 的账户资源包含 `CF_ACCOUNT_ID` 对应账户。
4. `CF_ACCOUNT_ID` 是 Account ID，不是 Zone ID。
5. Token 仍然有效；如有疑问，可重新创建 Token 并更新 GitHub Secret。

修正 Secret 或 Token 后，重新运行失败的工作流即可。
