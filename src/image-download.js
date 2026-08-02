import { enforceAccess } from "./access.js";
import { fetchUpstream, HttpError } from "./http.js";

const INDEX_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

function normalizeImage(value, env = {}) {
  let image = String(value || "").trim().replace(/^docker\.io\//, "");
  if (!image || image.includes("@") || !/^[a-z0-9._/-]+(?::[\w.-]+)?$/i.test(image)) throw new HttpError(400, "无效的 Docker Hub 镜像");
  let tag = "latest";
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon > slash) {
    tag = image.slice(colon + 1);
    image = image.slice(0, colon);
  }
  const repository = image.includes("/") ? image : `library/${image}`;
  enforceAccess(repository, env, "镜像");
  return { image, repository, tag };
}

async function tokenFor(repository, authorization = "") {
  const url = new URL("https://auth.docker.io/token");
  url.searchParams.set("service", "registry.docker.io");
  url.searchParams.set("scope", `repository:${repository}:pull`);
  const headers = new Headers({ accept: "application/json" });
  if (/^Basic\s+\S+$/i.test(authorization)) headers.set("authorization", authorization);
  const response = await fetchUpstream(url, { headers });
  if (!response.ok) throw new HttpError(response.status, "获取 Docker 下载令牌失败");
  const body = await response.json();
  if (!body.token && !body.access_token) throw new HttpError(502, "Docker 下载令牌无效");
  return body.token || body.access_token;
}

async function registryJson(repository, reference, token) {
  const url = new URL(`https://registry-1.docker.io/v2/${repository}/manifests/${reference}`);
  const response = await fetchUpstream(url, { headers: { accept: INDEX_ACCEPT, authorization: `Bearer ${token}` } });
  if (!response.ok) throw new HttpError(response.status, "获取镜像清单失败");
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    bytes,
    json: JSON.parse(new TextDecoder().decode(bytes)),
    digest: response.headers.get("docker-content-digest") || reference,
    mediaType: response.headers.get("content-type")?.split(";")[0] || "application/vnd.oci.image.manifest.v1+json",
  };
}

function selectManifest(index, platform) {
  const [os = "linux", architecture = "amd64", variant = ""] = platform.split("/");
  const descriptor = (index.manifests || []).find(item => {
    const current = item.platform || {};
    return current.os === os && current.architecture === architecture && (!variant || current.variant === variant);
  });
  if (!descriptor) throw new HttpError(404, `镜像不支持 ${platform} 架构`);
  return descriptor;
}

function octal(value, length) {
  return Math.max(0, value).toString(8).padStart(length - 1, "0") + "\0";
}

function tarHeader(name, size) {
  const block = new Uint8Array(512);
  const write = (text, offset, length) => block.set(new TextEncoder().encode(text).slice(0, length), offset);
  write(name, 0, 100);
  write(octal(0o644, 8), 100, 8);
  write(octal(0, 8), 108, 8);
  write(octal(0, 8), 116, 8);
  write(octal(size, 12), 124, 12);
  write(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
  block.fill(32, 148, 156);
  write("0", 156, 1);
  write("ustar\0", 257, 6);
  write("00", 263, 2);
  write("flarehub", 265, 32);
  write("flarehub", 297, 32);
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return block;
}

function padding(size) {
  return new Uint8Array((512 - (size % 512)) % 512);
}

function digestPath(digest) {
  const [algorithm, hash] = digest.split(":");
  if (!algorithm || !hash) throw new HttpError(502, "上游镜像摘要无效");
  return `blobs/${algorithm}/${hash}`;
}

async function writeBytes(controller, name, bytes) {
  controller.enqueue(tarHeader(name, bytes.byteLength));
  controller.enqueue(bytes);
  const pad = padding(bytes.byteLength);
  if (pad.byteLength) controller.enqueue(pad);
}

async function writeBlob(controller, repository, descriptor, token) {
  const url = new URL(`https://registry-1.docker.io/v2/${repository}/blobs/${descriptor.digest}`);
  const response = await fetchUpstream(url, { headers: { authorization: `Bearer ${token}` }, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`镜像层下载失败: ${response.status}`);
  controller.enqueue(tarHeader(digestPath(descriptor.digest), descriptor.size));
  const reader = response.body.getReader();
  let written = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    written += value.byteLength;
    controller.enqueue(value);
  }
  if (written !== descriptor.size) throw new Error("镜像层长度与清单不一致");
  const pad = padding(written);
  if (pad.byteLength) controller.enqueue(pad);
}

async function sha256(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function downloadDockerImage(request, env = {}) {
  if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "仅支持 GET/HEAD");
  const input = new URL(request.url);
  const image = normalizeImage(input.searchParams.get("image"), env);
  const platform = (input.searchParams.get("platform") || "linux/amd64").trim();
  if (!/^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)?$/.test(platform)) throw new HttpError(400, "无效的架构格式");

  const token = await tokenFor(image.repository, request.headers.get("authorization") || "");
  let manifest = await registryJson(image.repository, image.tag, token);
  if (Array.isArray(manifest.json.manifests)) {
    const selected = selectManifest(manifest.json, platform);
    manifest = await registryJson(image.repository, selected.digest, token);
  }
  if (!manifest.json.config || !Array.isArray(manifest.json.layers)) throw new HttpError(502, "上游镜像清单不完整");

  const manifestDigest = manifest.digest.startsWith("sha256:") ? manifest.digest : await sha256(manifest.bytes);
  const [os, architecture, variant] = platform.split("/");
  const indexPlatform = { os, architecture };
  if (variant) indexPlatform.variant = variant;
  const index = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2,
    manifests: [{
      mediaType: manifest.json.mediaType || manifest.mediaType,
      digest: manifestDigest,
      size: manifest.bytes.byteLength,
      annotations: { "org.opencontainers.image.ref.name": image.tag },
      platform: indexPlatform,
    }],
  }));
  const layout = new TextEncoder().encode('{"imageLayoutVersion":"1.0.0"}');
  const descriptors = [manifest.json.config, ...manifest.json.layers];
  const filename = `${image.image.replaceAll("/", "_")}_${image.tag}_${platform.replaceAll("/", "-")}.tar`;
  const headers = {
    "content-type": "application/x-tar",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };

  if (request.method === "HEAD") return new Response(null, { headers });

  const body = new ReadableStream({
    async start(controller) {
      try {
        await writeBytes(controller, "oci-layout", layout);
        await writeBytes(controller, "index.json", index);
        await writeBytes(controller, digestPath(manifestDigest), manifest.bytes);
        for (const descriptor of descriptors) await writeBlob(controller, image.repository, descriptor, token);
        controller.enqueue(new Uint8Array(1024));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(body, { headers });
}
