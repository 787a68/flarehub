import { mkdir, readFile, writeFile } from "node:fs/promises";

const source = new URL("../wrangler.jsonc", import.meta.url);
const outputDirectory = new URL("../.wrangler/", import.meta.url);
const output = new URL("deploy.jsonc", outputDirectory);
const config = JSON.parse(await readFile(source, "utf8"));
config.main = "../src/worker.js";
config.compatibility_date = new Date().toISOString().slice(0, 10);
if (config.assets) config.assets.directory = "../public";

const value = (name) => (process.env[name] || "").trim();
const accountId = value("CF_ACCOUNT_ID");
if (!accountId) throw new Error("Missing Actions secret: CF_ACCOUNT_ID");
config.account_id = accountId;

const enabled = (name, fallback = true) => {
  const configured = value(name).toLowerCase();
  if (!configured) return fallback;
  if (["1", "true", "yes", "on"].includes(configured)) return true;
  if (["0", "false", "no", "off"].includes(configured)) return false;
  throw new Error(`${name} must be true or false`);
};

const rules = (name) => value(name).split(",").map((item) => item.trim()).filter(Boolean);

const rateLimit = value("RATE_LIMITER");
if (rateLimit) {
  if (!/^\d+$/.test(rateLimit) || Number(rateLimit) < 1) {
    throw new Error("RATE_LIMITER must be a positive integer");
  }
  config.ratelimits[0].simple.limit = Number(rateLimit);
}

if (!enabled("DEPLOY_FRONTEND")) delete config.assets;

const caseInsensitive = /^(1|true|yes|on)$/i.test(String(process.env.CASE_INSENSITIVE || "").trim());
const frontendConfig = {
  whitelist: rules("WHITELIST"),
  blacklist: rules("BLACKLIST"),
  caseInsensitive,
};
config.vars = {
  ...(config.vars || {}),
  WHITELIST: frontendConfig.whitelist.join(","),
  BLACKLIST: frontendConfig.blacklist.join(","),
  CASE_INSENSITIVE: String(caseInsensitive),
};
const frontendConfigOutput = new URL("../public/config.js", import.meta.url);
await writeFile(frontendConfigOutput, `globalThis.FLAREHUB_CONFIG = ${JSON.stringify(frontendConfig)};\n`);

await mkdir(outputDirectory, { recursive: true });
await writeFile(output, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Prepared ${config.name} (${config.assets ? "Worker + frontend" : "Worker only"})`);
