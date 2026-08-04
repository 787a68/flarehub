/**
 * Prepare deployment configuration for Cloudflare Workers.
 *
 * Reads wrangler.jsonc, injects environment variables from CI,
 * sets up runtime env vars for access rules, and writes
 * the final deploy config to .wrangler/deploy.jsonc.
 */

import { mkdir, readFile, writeFile, cp } from "node:fs/promises";

const source = new URL("../wrangler.jsonc", import.meta.url);
const outputDir = new URL("../.wrangler/", import.meta.url);
const outputFile = new URL("deploy.jsonc", outputDir);

// Load base config
const config = JSON.parse(await readFile(source, "utf8"));
config.main = "../src/worker.js";
config.compatibility_date = new Date().toISOString().slice(0, 10);

// Helper: read trimmed env var
const env = (name) => (process.env[name] || "").trim();

// Inject Cloudflare account ID
const accountId = env("CF_ACCOUNT_ID");
if (!accountId) throw new Error("Missing env: CF_ACCOUNT_ID");
config.account_id = accountId;

// Helper: parse boolean env var
const bool = (name, fallback = true) => {
  const v = env(name).toLowerCase();
  if (!v) return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`${name} must be true or false`);
};

// Apply rate limiter override
const rateLimit = env("RATE_LIMITER");
if (rateLimit) {
  if (!/^\d+$/.test(rateLimit) || Number(rateLimit) < 1) {
    throw new Error("RATE_LIMITER must be a positive integer");
  }
  config.ratelimits[0].simple.limit = Number(rateLimit);
}

// Optionally disable frontend
if (!bool("DEPLOY_FRONTEND")) delete config.assets;

// Inject access rules as runtime env vars (read by Worker for access control)
config.vars = config.vars || {};
config.vars.WHITELIST = env("WHITELIST");
config.vars.BLACKLIST = env("BLACKLIST");
config.vars.CASE_INSENSITIVE = env("CASE_INSENSITIVE") || "false";

// Inline config into index.html so the frontend panel needs zero Worker calls
if (config.assets) {
  const parseList = (v) => (v || "").split(",").map(s => s.trim()).filter(Boolean);
  const panelConfig = JSON.stringify({
    whitelist: parseList(config.vars.WHITELIST),
    blacklist: parseList(config.vars.BLACKLIST),
    caseInsensitive: config.vars.CASE_INSENSITIVE === "true",
  }).replace(/[<\u2028\u2029]/g, (char) => {
    if (char === "<") return "\\u003c";
    return char === "\u2028" ? "\\u2028" : "\\u2029";
  });
  // Copy public/ → .wrangler/public/ as the assets directory
  const publicDir = new URL("../public/", import.meta.url);
  const assetsDir = new URL("public/", outputDir);
  await mkdir(outputDir, { recursive: true });
  await cp(publicDir, assetsDir, { recursive: true });
  // Overwrite index.html with inlined config
  const outHtml = new URL("index.html", assetsDir);
  let html = await readFile(outHtml, "utf8");
  html = html.replace("<!--FLAREHUB_CONFIG-->", `<script>window.__FLAREHUB_CONFIG__=${panelConfig};</script>`);
  await writeFile(outHtml, html);
  config.assets.directory = "../.wrangler/public";
}

// Write deploy config
await mkdir(outputDir, { recursive: true });
await writeFile(outputFile, `${JSON.stringify(config, null, 2)}\n`);

console.log(`Prepared ${config.name} (${config.assets ? "Worker + frontend" : "Worker only"})`);
