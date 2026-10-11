/**
 * Pure rule layer: schema limits, normalisation, matching and cross-device merge.
 *
 * Deliberately free of any `chrome.*` reference so it can be unit tested under
 * plain Node (see test/rules.test.js).
 */

// ── Storage layout ──────────────────────────────────────────
// Rules live under one sync key per rule (`chai_rule.<id>`) instead of a single
// array key, because chrome.storage.sync caps a single item at 8 KB while the
// whole area allows ~100 KB. The index records which ids exist.
export const INDEX_KEY = "chai_rule_index";
export const RULE_PREFIX = "chai_rule.";
export const TOMBSTONE_KEY = "chai_deleted_rules";
export const GLOBAL_ENABLED_KEY = "chai_global_enabled";
export const LEGACY_KEY = "chai_rules";

// ── Schema limits ───────────────────────────────────────────
export const LIMITS = {
  maxRules: 400,
  maxNameLength: 120,
  maxCssLength: 100_000,
  maxMatchValueLength: 500,
  maxMatchesPerRule: 200,
  maxTombstones: 300,
  maxSyncedRuleBytes: 7 * 1024,
};

export const MATCH_LISTS = ["whitelist", "blacklist"];
export const MATCH_TYPES = ["domain", "regex"];

// ── Small helpers ───────────────────────────────────────────
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Cut a string to `max` characters without splitting a surrogate pair. */
export function clampText(value, max) {
  const text = typeof value === "string" ? value : "";
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** Byte size of a value as JSON, which is what the sync quota is measured in. */
export function byteSize(value) {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
}

export function createRuleId() {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  if (cryptoObj?.getRandomValues) {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error("No secure random source available");
}

// ── Regex safety ────────────────────────────────────────────
// Nested quantifiers such as (a+)+ are the classic catastrophic-backtracking
// shape; a user rule carrying one can hang every page it matches.
const NESTED_QUANTIFIER = /\([^()]*[+*][^()]*\)\s*[+*{]/;

export function checkRegex(pattern) {
  if (typeof pattern !== "string" || pattern === "") {
    return { ok: false, reason: "empty pattern" };
  }
  if (pattern.length > LIMITS.maxMatchValueLength) {
    return { ok: false, reason: `pattern longer than ${LIMITS.maxMatchValueLength} characters` };
  }
  try {
    new RegExp(pattern);
  } catch (err) {
    return { ok: false, reason: `invalid regular expression (${err.message})` };
  }
  if (NESTED_QUANTIFIER.test(pattern)) {
    return { ok: false, reason: "pattern contains a nested quantifier that can backtrack catastrophically" };
  }
  return { ok: true };
}

export function makeRegex(pattern) {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

// ── Normalisation & validation ──────────────────────────────
export function normalizeMatchEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const list = MATCH_LISTS.includes(raw.list) ? raw.list : null;
  const matchType = MATCH_TYPES.includes(raw.matchType) ? raw.matchType : null;
  if (!list || !matchType) return null;
  const value = clampText(typeof raw.value === "string" ? raw.value.trim() : "", LIMITS.maxMatchValueLength);
  if (!value) return null;
  return { list, matchType, value };
}

function normalizeEntryList(rawEntries, list) {
  if (!Array.isArray(rawEntries)) return [];
  const out = [];
  for (const raw of rawEntries) {
    const entry = normalizeMatchEntry({ ...raw, list });
    if (entry) out.push({ matchType: entry.matchType, value: entry.value });
    if (out.length >= LIMITS.maxMatchesPerRule) break;
  }
  return out;
}

/**
 * Turn arbitrary input into a rule that is safe to store and to inject.
 *
 * An incoming `raw.id` is preserved unless `id` is given explicitly; callers
 * that merge across devices depend on ids being stable. `normalizeRules`
 * reissues ids only when an import reuses one.
 *
 * Returns `{ rule }` or `{ error }`; it never throws.
 */
export function normalizeRule(raw, { id, now = 0 } = {}) {
  if (!isPlainObject(raw)) return { error: "rule must be an object" };

  if (raw.whitelist !== undefined && !Array.isArray(raw.whitelist)) {
    return { error: "whitelist must be an array" };
  }
  if (raw.blacklist !== undefined && !Array.isArray(raw.blacklist)) {
    return { error: "blacklist must be an array" };
  }

  const css = clampText(typeof raw.css === "string" ? raw.css : "", LIMITS.maxCssLength);
  const name = clampText(typeof raw.name === "string" ? raw.name.trim() : "", LIMITS.maxNameLength);
  const candidateId = typeof id === "string" && id ? id : typeof raw.id === "string" && raw.id ? raw.id : null;

  const rule = {
    id: candidateId || createRuleId(),
    name,
    enabled: raw.enabled !== false,
    whitelist: normalizeEntryList(raw.whitelist, "whitelist"),
    blacklist: normalizeEntryList(raw.blacklist, "blacklist"),
    css,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
  };

  for (const entry of [...rule.whitelist, ...rule.blacklist]) {
    if (entry.matchType === "regex") {
      const check = checkRegex(entry.value);
      if (!check.ok) return { error: `invalid regex "${entry.value}": ${check.reason}` };
    }
  }

  return { rule };
}

/** Validate a whole import payload, reporting the first problem it finds. */
export function normalizeRules(rawList, { now = 0, max = LIMITS.maxRules } = {}) {
  if (!Array.isArray(rawList)) {
    return { error: "expected a JSON array of rules" };
  }
  if (rawList.length === 0) {
    return { error: "the array contains no rules" };
  }
  if (rawList.length > max) {
    return { error: `too many rules (${rawList.length}); the limit is ${max}` };
  }

  const rules = [];
  const seenIds = new Set();
  for (const [i, raw] of rawList.entries()) {
    const result = normalizeRule(raw, { now });
    if (result.error) return { error: `rule #${i + 1}: ${result.error}` };
    const rule = result.rule;
    // Imports must never let one device dictate another device's identity, so
    // colliding ids are reissued rather than trusted.
    if (seenIds.has(rule.id)) rule.id = createRuleId();
    seenIds.add(rule.id);
    rules.push(rule);
  }
  return { rules };
}

// ── Matching ────────────────────────────────────────────────
export function testEntry(entry, url, hostname) {
  if (!entry || typeof entry.value !== "string") return false;
  if (entry.matchType === "domain") {
    const value = entry.value.toLowerCase();
    return hostname === value || hostname.endsWith("." + value);
  }
  if (entry.matchType === "regex") {
    const regex = makeRegex(entry.value);
    return regex ? regex.test(url) : false;
  }
  return false;
}

export function ruleMatches(rule, url, hostname) {
  if (!rule || !rule.enabled) return false;
  const whitelist = Array.isArray(rule.whitelist) ? rule.whitelist : [];
  if (whitelist.length === 0) return false;
  if (!whitelist.some((entry) => testEntry(entry, url, hostname))) return false;
  const blacklist = Array.isArray(rule.blacklist) ? rule.blacklist : [];
  if (blacklist.some((entry) => testEntry(entry, url, hostname))) return false;
  return true;
}

export function matchingRules(rules, url, hostname) {
  return (Array.isArray(rules) ? rules : []).filter((rule) => ruleMatches(rule, url, hostname));
}

// ── Cross-device merge ──────────────────────────────────────
export function isTombstone(value) {
  return isPlainObject(value) && value.deleted === true && typeof value.id === "string";
}

export function isRuleRecord(value) {
  return isPlainObject(value) && typeof value.id === "string" && typeof value.css === "string";
}

export function isIndex(value) {
  return isPlainObject(value) && Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string");
}

/**
 * A storage key holding exactly one rule.
 *
 * Metadata keys use underscores (`chai_rule_index`) while rule keys use a dot
 * (`chai_rule.<id>`), so the two namespaces can never collide.
 */
export function isRuleKey(key) {
  return typeof key === "string" && key.startsWith(RULE_PREFIX) && key.length > RULE_PREFIX.length;
}

function tombstoneMap(list) {
  const map = new Map();
  if (!Array.isArray(list)) return map;
  for (const item of list) {
    if (isTombstone(item)) {
      map.set(item.id, item.deletedAt || 0);
    } else if (Array.isArray(item) && typeof item[0] === "string") {
      // Compact [id, deletedAt] form, used when folding in a local snapshot.
      map.set(item[0], item[1] || 0);
    }
  }
  return map;
}

/** Accept either an array of rules or the Map the store keeps in its cache. */
function ruleIterable(value) {
  if (value instanceof Map) return value.values();
  if (Array.isArray(value)) return value;
  return [];
}

/**
 * How recently a rule must have changed to be presumed still in flight. A rule
 * present in storage but missing from the index it arrived with is an orphan —
 * unless it is this fresh, in which case the index simply predates the insert.
 */
export const INDEX_SWEEP_GRACE_MS = 10_000;

/**
 * Fold an incoming `storage.onChanged` batch into the local state.
 *
 * Synchronisation is last-write-wins per rule, resolved on `updatedAt`. A rule
 * arriving from elsewhere is ignored when we hold a newer deletion tombstone for
 * it, and a stale tombstone is dropped when a genuinely newer edit arrives —
 * without that check, a delete on device A would be silently undone by an
 * offline edit on device B.
 */
export function mergeIncoming(local, changes, { now = Date.now() } = {}) {
  const rules = new Map();
  for (const entry of ruleIterable(local.rules)) {
    if (isRuleRecord(entry)) rules.set(entry.id, entry);
  }

  const tombstones = tombstoneMap(local.tombstones);
  let index = local.index;
  const indexArrived = isIndex(changes[INDEX_KEY]);

  if (indexArrived) {
    index = changes[INDEX_KEY];
  }

  if (Array.isArray(changes[TOMBSTONE_KEY])) {
    for (const [id, deletedAt] of tombstoneMap(changes[TOMBSTONE_KEY])) {
      // Monotonic: a replayed older tombstone must not lower a known one.
      if (deletedAt > (tombstones.get(id) ?? 0)) tombstones.set(id, deletedAt);
    }
  }

  for (const [key, value] of Object.entries(changes)) {
    if (!isRuleKey(key)) continue;
    const id = key.slice(RULE_PREFIX.length);

    if (isRuleRecord(value)) {
      const deletedAt = tombstones.get(id) ?? 0;
      if (deletedAt > (value.updatedAt || 0)) continue;
      const current = rules.get(id);
      if (!current || (value.updatedAt || 0) >= (current.updatedAt || 0)) {
        rules.set(id, value);
        tombstones.delete(id);
      }
      continue;
    }

    if (isTombstone(value)) {
      if ((value.deletedAt || 0) > (tombstones.get(id) ?? 0)) {
        tombstones.set(id, value.deletedAt || 0);
      }
      rules.delete(id);
      continue;
    }

    if (value === undefined || value === null) {
      rules.delete(id);
    }
  }

  // An index that arrives on its own carries no timestamp, so it cannot prove a
  // rule was deleted. Rules genuinely removed elsewhere arrive as tombstones;
  // only clear out orphans the index excludes that are too old to be a
  // concurrent insert still in flight.
  if (indexArrived && isIndex(index)) {
    const live = new Set(index.ids);
    for (const [id, entry] of [...rules]) {
      if (live.has(id)) continue;
      if (now - (entry.updatedAt || 0) < INDEX_SWEEP_GRACE_MS) continue;
      rules.delete(id);
    }
  }

  return {
    index: index || { ids: [] },
    rules,
    tombstones,
  };
}

/** Prune tombstones to a bounded, newest-first list. */
export function pruneTombstones(map, max = LIMITS.maxTombstones) {
  return [...map.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(-max);
}
