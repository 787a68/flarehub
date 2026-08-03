/**
 * Access control: whitelist / blacklist keyword matching.
 * Blacklist takes priority over whitelist.
 */

/**
 * Parse a comma-separated env string into a trimmed keyword array.
 * Returns [] for empty / whitespace-only input.
 */
export function parseList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Check if a target string contains any of the keywords.
 * @param {string} target - The string to check (e.g. "owner/repo")
 * @param {string[]} keywords - Keywords to match against
 * @param {boolean} caseInsensitive - Whether to ignore case
 * @returns {boolean} true if any keyword is a substring of target
 */
function matches(target, keywords, caseInsensitive) {
  if (keywords.length === 0) return false;
  if (!caseInsensitive) return keywords.some(k => target.includes(k));
  const t = target.toLowerCase();
  return keywords.some(k => t.includes(k.toLowerCase()));
}

/**
 * Determine if a request should be allowed based on access rules.
 *
 * Logic:
 * 1. If target matches blacklist → deny (blacklist wins)
 * 2. If whitelist is empty → allow all (not blacklisted)
 * 3. If whitelist is non-empty → allow only if target matches whitelist
 *
 * @param {string} target - Identifier to check (owner/repo, image name, etc.)
 * @param {object} env - Environment with WHITELIST, BLACKLIST, CASE_INSENSITIVE
 * @returns {{ allowed: boolean, reason: string }}
 */
export function checkAccess(target, env) {
  const whitelist = parseList(env.WHITELIST);
  const blacklist = parseList(env.BLACKLIST);
  const ci = env.CASE_INSENSITIVE === true || env.CASE_INSENSITIVE === 'true';

  if (matches(target, blacklist, ci)) {
    return { allowed: false, reason: 'blocked by blacklist' };
  }

  if (whitelist.length === 0) {
    return { allowed: true, reason: 'no whitelist' };
  }

  if (matches(target, whitelist, ci)) {
    return { allowed: true, reason: 'matched whitelist' };
  }

  return { allowed: false, reason: 'not in whitelist' };
}
