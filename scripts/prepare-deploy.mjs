import { mkdir, readFile, writeFile } from "node:fs/promises";

const source = new URL("../wrangler.jsonc", import.meta.url);
const outputDirectory = new URL("../.wrangler/", import.meta.url);
const output = new URL("deploy.jsonc", outputDirectory);
const config = JSON.parse(await readFile(source, "utf8"));
config.main = "../src/worker.js";
config.compatibility_date = new Date().toISOString().slice(0, 10);
if (config.assets) config.assets.directory = "../public";

const value = (name) => (process.env[name] || "").trim();
const enabled = (name, fallback = true) => {
  const configured = value(name).toLowerCase();
  if (!configured) return fallback;
  if (["1", "true", "yes", "on"].includes(configured)) return true;
  if (["0", "false", "no", "off"].includes(configured)) return false;
  throw new Error(`${name} must be true or false`);
};

config.vars = {
  ...(config.vars || {}),
  WHITELIST: value("WHITELIST"),
  BLACKLIST: value("BLACKLIST"),
};

const rateLimit = value("RATE_LIMITER");
if (rateLimit) {
  if (!/^\d+$/.test(rateLimit) || Number(rateLimit) < 1) {
    throw new Error("RATE_LIMITER must be a positive integer");
  }
  config.ratelimits[0].simple.limit = Number(rateLimit);
}

if (!enabled("DEPLOY_FRONTEND")) delete config.assets;

await mkdir(outputDirectory, { recursive: true });
await writeFile(output, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Prepared ${config.name} (${config.assets ? "Worker + frontend" : "Worker only"})`);
