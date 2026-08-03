// @ts-check
// flarehub — Cloudflare Worker: GitHub / Docker / HuggingFace 代理
// 参考 hubproxy 实现模式
import { isGithubTarget, proxyGithub } from './github.js';
import { downloadDockerImage } from './image-download.js';
import { HttpError, json, preflight } from './http.js';
import { proxyRegistry, proxyRegistryToken } from './registry.js';

export { accessAllowed } from './access.js';
export { githubRepository, githubTargetFromRequest, parseGithubTarget } from './github.js';
export { parseRegistryRequest, registryConfig, registryRepository } from './registry.js';

export default {
  async fetch(request, env = {}) {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) {
        const resp = json({ error: error.message }, error.status);
        resp.headers.set('access-control-allow-origin', '*');
        if (error.status === 429) resp.headers.set('retry-after', '60');
        return resp;
      }
      if (error instanceof TypeError) {
        const resp = json({ error: '上游服务暂时不可达' }, 502);
        resp.headers.set('access-control-allow-origin', '*');
        return resp;
      }
      const resp = json({ error: '服务器内部错误' }, 500);
      resp.headers.set('access-control-allow-origin', '*');
      return resp;
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);

  // ── Rate limiting ──────────────────────────────────────────────────────
  if (env.RATE_LIMITER) {
    const actor = request.headers.get('cf-connecting-ip') || 'anonymous';
    const { success } = await env.RATE_LIMITER.limit({ key: actor });
    if (!success) {
      const resp = json({ error: '请求过于频繁，请稍后再试' }, 429);
      resp.headers.set('access-control-allow-origin', '*');
      resp.headers.set('retry-after', '60');
      return resp;
    }
  }

  // ── CORS preflight ─────────────────────────────────────────────────────
  if (request.method === 'OPTIONS') {
    const methods = (url.pathname === '/v2' || url.pathname.startsWith('/v2/'))
      ? 'GET, HEAD, PUT, POST, PATCH, DELETE, OPTIONS'
      : 'GET, HEAD, OPTIONS';
    return preflight(methods);
  }

  // ── Docker image download ──────────────────────────────────────────────
  if (url.pathname === '/api/image/download') {
    return downloadDockerImage(request, env);
  }

  // ── Docker Registry v2 proxy ───────────────────────────────────────────
  if (url.pathname === '/token') return proxyRegistryToken(request, env);
  if (url.pathname === '/v2' || url.pathname.startsWith('/v2/')) {
    return proxyRegistry(request, env);
  }

  // ── GitHub / HuggingFace / Docker binary proxy ─────────────────────────
  if (isGithubTarget(url.pathname)) {
    return proxyGithub(request, env);
  }

  // ── Static assets (Cloudflare Pages) ──────────────────────────────────
  if (env.ASSETS) return env.ASSETS.fetch(request);

  return new Response('Not found', { status: 404 });
}
