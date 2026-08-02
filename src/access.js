import { HttpError } from "./http.js";

function rules(value) {
  return String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

export function matchWildcard(identity, ruleList) {
  const fullName = identity.toLowerCase().replace(/\.git$/, "");
  const parts = fullName.split("/");
  const namespace = parts[0] || "";
  const repository = parts.at(-1) || "";

  return ruleList.some((item) => {
    if (item === fullName || item === namespace || item === `${namespace}/*`) return true;
    if (item.endsWith("*") && fullName.startsWith(item.slice(0, -1))) return true;
    if (fullName.startsWith(`${item}/`)) return true;
    if (!item.startsWith("*/")) return false;
    const pattern = item.slice(2);
    return pattern === repository || (pattern.endsWith("*") && repository.startsWith(pattern.slice(0, -1)));
  });
}

export function accessAllowed(identity, env = {}) {
  if (!identity) return true;
  const whitelist = rules(env.WHITELIST);
  const blacklist = rules(env.BLACKLIST);
  return (!whitelist.length || matchWildcard(identity, whitelist)) && !matchWildcard(identity, blacklist);
}

export function publicAccessConfig(env = {}) {
  return {
    whitelist: rules(env.WHITELIST),
    blacklist: rules(env.BLACKLIST),
  };
}

export function enforceAccess(identity, env, kind = "资源") {
  if (!accessAllowed(identity, env)) throw new HttpError(403, `${kind}不允许访问`);
}
