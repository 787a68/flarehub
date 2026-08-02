import { HttpError } from "./http.js";

const splitKeywords = (value) => String(value || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const caseInsensitive = (env) => /^(1|true|yes|on)$/i.test(String(env.CASE_INSENSITIVE || "").trim());

export function accessAllowed(value, env = {}) {
  const ignoreCase = caseInsensitive(env);
  const normalize = (item) => ignoreCase ? item.toLowerCase() : item;
  const target = normalize(String(value || ""));
  const whitelist = splitKeywords(env.WHITELIST).map(normalize);
  const blacklist = splitKeywords(env.BLACKLIST).map(normalize);
  if (blacklist.some((keyword) => target.includes(keyword))) return false;
  return whitelist.length === 0 || whitelist.some((keyword) => target.includes(keyword));
}

export function enforceAccess(value, env = {}, label = "资源") {
  if (!accessAllowed(value, env)) throw new HttpError(403, `${label}不符合访问规则`);
}
