/**
 * Reactive rule store: in-memory cache + optimistic writes + remote merging.
 *
 * This is the module the extension surfaces (options page, popup, service
 * worker) talk to. It keeps exactly one authoritative cache per context and
 * republishes it whenever another device pushes a change.
 */

import {
  GLOBAL_ENABLED_KEY,
  INDEX_KEY,
  LIMITS,
  RULE_PREFIX,
  TOMBSTONE_KEY,
  isRuleKey,
  isRuleRecord,
  mergeIncoming,
  normalizeRule,
} from "./rules.js";
import { ChaiStorageError, createSyncStore } from "./storage.js";

function sortRules(rules) {
  return [...rules].sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.id).localeCompare(String(b.id)),
  );
}

function diffStates(previous, next) {
  const changes = {};
  const keys = new Set([...previous.keys(), ...next.keys()]);
  for (const key of keys) {
    const before = previous.get(key);
    const after = next.get(key);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes[key] = after;
    }
  }
  return changes;
}

export function createRuleStore({
  store = createSyncStore(),
  onError = () => {},
  watch = true,
} = {}) {
  let cache = { rules: new Map(), index: { ids: [] }, tombstones: [], globalEnabled: true };
  let ready = false;
  let listeners = new Set();

  const unsubscribeBackend = [];

  function snapshot() {
    return {
      rules: sortRules(cache.rules.values()),
      globalEnabled: cache.globalEnabled,
      ruleCount: cache.rules.size,
    };
  }

  function emit() {
    const value = snapshot();
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (err) {
        onError(err);
      }
    }
  }

  function report(err) {
    onError(err instanceof ChaiStorageError ? err : new ChaiStorageError("WRITE_FAILED", String(err?.message || err), { cause: err }));
  }

  function toChangeMap(raw) {
    const map = new Map();
    for (const [key, value] of Object.entries(raw || {})) {
      if (isRuleKey(key) || key === INDEX_KEY || key === TOMBSTONE_KEY || key === GLOBAL_ENABLED_KEY) {
        map.set(key, value);
      }
    }
    return map;
  }

  /** Index + tombstones + every rule, as a flat map of sync keys. */
  async function readToMap() {
    const state = await store.readState();
    const map = new Map();
    for (const [id, rule] of state.rules) map.set(RULE_PREFIX + id, rule);
    map.set(INDEX_KEY, state.index);
    map.set(TOMBSTONE_KEY, state.tombstones);
    map.set(GLOBAL_ENABLED_KEY, state.globalEnabled);
    return { state, map };
  }

  async function load() {
    const { state, map } = await readToMap();
    cache = {
      rules: state.rules,
      index: state.index,
      tombstones: state.tombstones,
      globalEnabled: state.globalEnabled,
    };
    ready = true;
    emit();
    return { ...snapshot(), map };
  }

  async function ensureLoaded() {
    if (!ready) await load();
    return snapshot();
  }

  /** Fold a batch of sync changes into the cache without a full re-read. */
  function applyChanges(rawChanges) {
    if (!rawChanges || Object.keys(rawChanges).length === 0) return false;

    const hasRuleChange = Object.keys(rawChanges).some(
      (key) => key.startsWith(RULE_PREFIX) || key === INDEX_KEY || key === TOMBSTONE_KEY,
    );
    const hasSettingsChange = GLOBAL_ENABLED_KEY in rawChanges;

    if (hasRuleChange) {
      const merged = mergeIncoming(
        { rules: cache.rules, index: cache.index, tombstones: cache.tombstones },
        rawChanges,
      );
      cache = {
        rules: merged.rules,
        index: merged.index,
        tombstones: pruneToArray(merged.tombstones),
        globalEnabled: cache.globalEnabled,
      };
    }
    if (hasSettingsChange) {
      cache.globalEnabled = rawChanges[GLOBAL_ENABLED_KEY] !== false;
    }
    emit();
    return true;
  }

  function pruneToArray(map) {
    return [...map.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .slice(-LIMITS.maxTombstones)
      .map(([id, deletedAt]) => ({ id, deleted: true, deletedAt }));
  }

  // ── Writes ────────────────────────────────────────────────
  /**
   * @param nextRules      the complete desired rule set
   * @param previousRules  the set this device believed in before this change;
   *                       passing a stale snapshot makes deletions look like
   *                       concurrent creations and silently drops them
   */
  async function commit(nextRules, previousRules) {
    await ensureLoaded();
    const previous = previousRules ?? snapshot().rules;
    const beforeMap = await readToMap();

    const { rules: written } = await store.writeRules(nextRules, previous);
    const afterMap = await readToMap();
    const changes = diffStates(beforeMap.map, afterMap.map);
    if (Object.keys(changes).length > 0) {
      applyChanges(changes);
    } else {
      cache = { ...cache, rules: new Map(written.map((rule) => [rule.id, rule])) };
      emit();
    }
    return snapshot();
  }

  async function addRule(rule) {
    await ensureLoaded();
    const result = normalizeRule(rule, { now: Date.now() });
    if (result.error) {
      throw new ChaiStorageError("INVALID_RULE", result.error);
    }
    const current = snapshot().rules;
    if (current.length >= LIMITS.maxRules) {
      throw new ChaiStorageError("LIMIT_EXCEEDED", `At most ${LIMITS.maxRules} rules can be synced.`);
    }
    const next = [...current, result.rule];
    cache = { ...cache, rules: new Map(next.map((r) => [r.id, r])) };
    emit();
    try {
      return await commit(next, current);
    } catch (err) {
      report(err);
      throw err;
    }
  }

  async function updateRule(id, updates) {
    await ensureLoaded();
    const current = snapshot().rules;
    const existing = current.find((rule) => rule.id === id);
    if (!existing) {
      throw new ChaiStorageError("NOT_FOUND", `No rule with id ${id}`);
    }
    const result = normalizeRule({ ...existing, ...updates }, { id, now: Date.now() });
    if (result.error) {
      throw new ChaiStorageError("INVALID_RULE", result.error);
    }
    const next = current.map((rule) => (rule.id === id ? result.rule : rule));
    cache = { ...cache, rules: new Map(next.map((r) => [r.id, r])) };
    emit();
    try {
      return await commit(next, current);
    } catch (err) {
      report(err);
      throw err;
    }
  }

  async function deleteRule(id) {
    await ensureLoaded();
    const current = snapshot().rules;
    const next = current.filter((rule) => rule.id !== id);
    if (next.length === current.length) return snapshot();
    cache = { ...cache, rules: new Map(next.map((r) => [r.id, r])) };
    emit();
    try {
      return await commit(next, current);
    } catch (err) {
      report(err);
      throw err;
    }
  }

  async function setGlobalEnabled(enabled) {
    const value = enabled !== false;
    const previous = cache.globalEnabled;
    cache = { ...cache, globalEnabled: value };
    emit();
    try {
      await store.setGlobalEnabled(value);
      return value;
    } catch (err) {
      cache = { ...cache, globalEnabled: previous };
      emit();
      report(err);
      throw err;
    }
  }

  /**
   * Authoritative re-read. Used when the context was suspended (a service worker
   * restart) or when a write failure means the cache may be stale.
   */
  async function syncNow() {
    const { state, map } = await readToMap();
    const merged = mergeIncoming(
      { rules: cache.rules, index: cache.index, tombstones: cache.tombstones },
      Object.fromEntries(map),
    );
    const nextState = {
      rules: merged.rules,
      index: merged.index,
      tombstones: pruneToArray(merged.tombstones),
      globalEnabled: state.globalEnabled,
    };
    const changed = diffStates(
      new Map([
        ...[...cache.rules].map(([id, rule]) => [RULE_PREFIX + id, rule]),
        [GLOBAL_ENABLED_KEY, cache.globalEnabled],
      ]),
      new Map([
        ...[...nextState.rules].map(([id, rule]) => [RULE_PREFIX + id, rule]),
        [GLOBAL_ENABLED_KEY, nextState.globalEnabled],
      ]),
    );
    cache = nextState;
    ready = true;
    if (Object.keys(changed).length > 0) emit();
    return snapshot();
  }

  function subscribe(listener, { immediate = true } = {}) {
    listeners.add(listener);
    if (immediate && ready) listener(snapshot());
    return () => listeners.delete(listener);
  }

  if (watch && typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    const handler = (changes, area) => {
      if (area !== "sync") return;
      const raw = toChangeMap(changes);
      const flat = {};
      for (const [key, change] of raw) {
        if (change && typeof change === "object" && "newValue" in change) {
          flat[key] = change.newValue;
        }
      }
      applyChanges(flat);
    };
    chrome.storage.onChanged.addListener(handler);
    unsubscribeBackend.push(() => chrome.storage.onChanged.removeListener(handler));
  }

  return {
    load,
    ensureLoaded,
    snapshot,
    subscribe,
    addRule,
    updateRule,
    deleteRule,
    setGlobalEnabled,
    syncNow,
    usage: () => store.usage(),
    migrateLegacy: () => store.migrateLegacy(),
    clearAll: () => store.clearAll(),
    dispose() {
      for (const off of unsubscribeBackend) off();
      unsubscribeBackend.length = 0;
      listeners = new Set();
    },
  };
}

export { isRuleRecord };
