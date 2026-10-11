/**
 * Sync storage adapter: per-rule keys, quota awareness and typed failures.
 *
 * Every value that leaves this module has already been through
 * `normalizeRule`, so callers can assume the shape is correct.
 */

import {
  GLOBAL_ENABLED_KEY,
  INDEX_KEY,
  LEGACY_KEY,
  LIMITS,
  RULE_PREFIX,
  TOMBSTONE_KEY,
  byteSize,
  clampText,
  isIndex,
  isRuleRecord,
  isTombstone,
  normalizeRule,
  pruneTombstones,
} from "./rules.js";

/** Typed error so the UI can tell "sync is off" apart from "too big". */
export class ChaiStorageError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "ChaiStorageError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Classify a chrome.storage failure. The runtime surfaces most problems as a
 * bare `runtime.lastError`, so we fall back to message sniffing.
 */
export function classifyError(error) {
  const message = String(error?.message || error || "unknown error");
  if (/quota|MAX_WRITE|MAX_ITEMS|too much|exceeded/i.test(message)) {
    return new ChaiStorageError(
      "QUOTA_EXCEEDED",
      "Configuration exceeds the browser sync quota. Remove some rules or shorten their CSS.",
      { cause: message },
    );
  }
  if (/MAX_SUSTAINED_WRITE|MAX_SUSTAINED/i.test(message)) {
    return new ChaiStorageError(
      "RATE_LIMITED",
      "Sync writes are being rate limited. Changes were saved locally and will retry.",
      { cause: message },
    );
  }
  return new ChaiStorageError("WRITE_FAILED", `Could not write to sync storage: ${message}`, {
    cause: message,
  });
}

const RETRY_DELAY_MS = 250;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Real `chrome.storage.sync` implementation of the adapter interface. */
export function createChromeSyncAdapter(area = globalThis.chrome?.storage?.sync) {
  if (!area) {
    throw new ChaiStorageError("UNAVAILABLE", "chrome.storage.sync is not available in this context.");
  }
  const call = (method, ...args) =>
    new Promise((resolve, reject) => {
      try {
        area[method](...args, (result) => {
          const lastError = globalThis.chrome?.runtime?.lastError;
          if (lastError) {
            reject(new Error(lastError.message));
            return;
          }
          resolve(result);
        });
      } catch (err) {
        reject(err);
      }
    });

  return {
    areaName: "sync",
    get: (keys) => call("get", keys),
    set: (items) => call("set", items),
    remove: (keys) => call("remove", keys),
    clear: () => call("clear"),
    getBytesInUse: (keys) => call("getBytesInUse", keys),
  };
}

/**
 * Higher level store over the adapter.
 *
 * The store owns the *shape* of the sync area: an index of ids, one key per
 * rule, a tombstone list and scalar settings.
 */
export function createStore(adapter) {
  async function readRaw() {
    try {
      return (await adapter.get(null)) || {};
    } catch (err) {
      throw classifyError(err);
    }
  }

  function parseState(raw) {
    const index = isIndex(raw[INDEX_KEY]) ? raw[INDEX_KEY] : { ids: [] };
    const rules = new Map();
    for (const [key, value] of Object.entries(raw)) {
      if (!key.startsWith(RULE_PREFIX)) continue;
      if (isRuleRecord(value)) rules.set(value.id, value);
    }
    // The index is a hint for enumeration; keys are the source of truth, and any
    // rule present in the area but missing from the index is still recovered.
    for (const id of index.ids) {
      if (rules.has(id)) continue;
      const value = raw[RULE_PREFIX + id];
      if (isRuleRecord(value)) rules.set(id, value);
    }
    const tombstones = Array.isArray(raw[TOMBSTONE_KEY]) ? raw[TOMBSTONE_KEY].filter(isTombstone) : [];
    return {
      rules,
      index,
      tombstones,
      globalEnabled: raw[GLOBAL_ENABLED_KEY] !== false,
    };
  }

  async function readState() {
    return parseState(await readRaw());
  }

  function collectKeys(state) {
    const keys = [...state.rules.keys()].map((id) => RULE_PREFIX + id);
    keys.push(INDEX_KEY, TOMBSTONE_KEY, GLOBAL_ENABLED_KEY);
    return keys;
  }

  async function setWithRetry(items) {
    try {
      await adapter.set(items);
    } catch (err) {
      const classified = classifyError(err);
      // A single retry absorbs the transient "service worker was busy" failures
      // that show up as generic write errors.
      if (classified.code === "WRITE_FAILED") {
        await delay(RETRY_DELAY_MS);
        try {
          await adapter.set(items);
          return;
        } catch (retryErr) {
          throw classifyError(retryErr);
        }
      }
      throw classified;
    }
  }

  /**
   * Append rules without deleting anything.
   *
   * Used for migrations and imports, where the payload is additive: treating
   * rules missing from the payload as deletions would wipe the account.
   */
  async function insertRules(incomingRules) {
    const raw = await readRaw();
    const state = parseState(raw);
    const merged = [...state.rules.values()];
    const knownIds = new Set(merged.map((rule) => rule.id));

    for (const rawRule of incomingRules) {
      const result = normalizeRule(rawRule, { now: Date.now() });
      if (result.error) {
        throw new ChaiStorageError("INVALID_RULE", `Rule rejected: ${result.error}`);
      }
      if (knownIds.has(result.rule.id)) continue;
      knownIds.add(result.rule.id);
      merged.push(result.rule);
    }

    // `previousRules` is the pre-existing set, so nothing is tombstoned.
    return writeRules(merged, [...state.rules.values()]);
  }

  /**
   * Persist the given rules as the complete set. Ids this device previously knew
   * about but that are absent become tombstones, so a delete on one device is not
   * resurrected by an offline device holding a stale copy.
   */
  async function writeRules(nextRules, previousRules = []) {
    if (nextRules.length > LIMITS.maxRules) {
      throw new ChaiStorageError(
        "LIMIT_EXCEEDED",
        `At most ${LIMITS.maxRules} rules can be synced (attempted ${nextRules.length}).`,
      );
    }

    const nextById = new Map();
    for (const raw of nextRules) {
      const result = normalizeRule(raw, { id: raw?.id });
      if (result.error) {
        throw new ChaiStorageError("INVALID_RULE", `Rule rejected: ${result.error}`);
      }
      nextById.set(result.rule.id, result.rule);
    }

    const raw = await readRaw();
    const state = parseState(raw);
    const tombstones = new Map(state.tombstones.map((item) => [item.id, item.deletedAt || 0]));
    const now = Date.now();

    const items = {};
    const changedIds = new Set();
    for (const [id, rule] of nextById) {
      const stored = state.rules.get(id);
      if (stored && stored.updatedAt === rule.updatedAt && JSON.stringify(stored) === JSON.stringify(rule)) {
        continue;
      }
      const record = { ...rule, updatedAt: rule.updatedAt || now };
      const size = byteSize(record);
      if (size > LIMITS.maxSyncedRuleBytes) {
        throw new ChaiStorageError(
          "RULE_TOO_LARGE",
          `Rule "${record.name || record.id}" is ${size} bytes; a single synced rule must stay under ${LIMITS.maxSyncedRuleBytes} bytes.`,
          { id: record.id, size },
        );
      }
      items[RULE_PREFIX + id] = record;
      changedIds.add(id);
    }

    const previousIds = new Set(previousRules.map((rule) => rule?.id).filter(Boolean));

    // Rules that appeared in storage while this device was editing were created
    // elsewhere: adopt them rather than treating their absence from `nextRules`
    // as a deletion. Only rules this device knew about can be deleted.
    const allById = new Map(nextById);
    const adopted = [];
    for (const [id, stored] of state.rules) {
      if (allById.has(id) || previousIds.has(id)) continue;
      allById.set(id, stored);
      adopted.push(id);
    }

    const removedIds = [...previousIds].filter((id) => !allById.has(id));
    for (const id of removedIds) {
      tombstones.set(id, now);
      changedIds.add(id);
    }

    const nextIndex = { ids: [...allById.keys()].sort() };
    const indexChanged =
      nextIndex.ids.length !== state.index.ids.length ||
      nextIndex.ids.some((id, i) => id !== state.index.ids[i]);

    if (changedIds.size === 0 && adopted.length === 0 && !indexChanged) {
      return { rules: [...allById.values()], changedIds: [] };
    }

    for (const id of changedIds) {
      const record = nextById.get(id);
      items[RULE_PREFIX + id] = record ? { ...record, updatedAt: record.updatedAt || now } : undefined;
    }
    for (const id of removedIds) {
      items[RULE_PREFIX + id] = { id, deleted: true, deletedAt: tombstones.get(id) || now };
    }
    if (indexChanged) items[INDEX_KEY] = nextIndex;

    const pruned = pruneTombstones(tombstones);
    const currentTombstones = JSON.stringify(state.tombstones.map((t) => [t.id, t.deletedAt]));
    const nextTombstones = JSON.stringify(pruned);
    if (currentTombstones !== nextTombstones) {
      items[TOMBSTONE_KEY] = pruned.map(([id, deletedAt]) => ({ id, deleted: true, deletedAt }));
    }

    for (const [key, value] of Object.entries(items)) {
      if (value === undefined) delete items[key];
    }

    await setWithRetry(items);
    return { rules: [...allById.values()], changedIds: [...changedIds] };
  }

  async function setGlobalEnabled(enabled) {
    await setWithRetry({ [GLOBAL_ENABLED_KEY]: enabled !== false });
  }

  /** Bytes currently held in the sync area, for the settings page meter. */
  async function usage() {
    const raw = await readRaw();
    const state = parseState(raw);
    let bytes;
    if (typeof adapter.getBytesInUse === "function") {
      try {
        bytes = await adapter.getBytesInUse(null);
      } catch {
        bytes = undefined;
      }
    }
    return {
      bytes: typeof bytes === "number" ? bytes : byteSize(raw),
      ruleCount: state.rules.size,
      indexCount: state.index.ids.length,
      tombstoneCount: state.tombstones.length,
    };
  }

  /** One-time migration from the pre-1.1 single-array layout. */
  async function migrateLegacy() {
    const raw = await readRaw();
    const legacy = raw[LEGACY_KEY];
    if (!Array.isArray(legacy)) return { migrated: 0 };

    const state = parseState(raw);
    const knownIds = new Set(state.rules.keys());
    const additions = [];
    const now = Date.now();

    for (const rawRule of legacy) {
      const result = normalizeRule(rawRule, { now });
      if (result.error) continue;
      if (knownIds.has(result.rule.id)) continue;
      knownIds.add(result.rule.id);
      additions.push(result.rule);
    }

    if (additions.length > 0) {
      await insertRules(additions);
    }
    try {
      await adapter.remove([LEGACY_KEY]);
    } catch {
      // Leaving the old key behind is harmless: migration is idempotent.
    }
    return { migrated: additions.length };
  }

  async function clearAll() {
    await adapter.clear();
  }

  return {
    areaName: adapter.areaName,
    readRaw,
    readState,
    collectKeys,
    writeRules,
    insertRules,
    setGlobalEnabled,
    usage,
    migrateLegacy,
    clearAll,
  };
}

/** Default store bound to the real sync area. */
export function createSyncStore() {
  return createStore(createChromeSyncAdapter());
}

export { clampText };
