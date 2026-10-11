import test from "node:test";
import assert from "node:assert/strict";

import { createStore, createChromeSyncAdapter, classifyError, ChaiStorageError } from "../src/shared/storage.js";
import { createRuleStore } from "../src/shared/ruleStore.js";
import { INDEX_KEY, LEGACY_KEY, LIMITS, RULE_PREFIX, TOMBSTONE_KEY } from "../src/shared/rules.js";
import { createFakeAdapter, installChromeStub } from "./fakeChrome.js";

function newStore(options = {}) {
  const adapter = createFakeAdapter(options);
  return { adapter, store: createStore(adapter) };
}

test("classifyError maps quota failures to a typed error", () => {
  const quota = classifyError(new Error("QUOTA_BYTES quota exceeded"));
  assert.equal(quota.code, "QUOTA_EXCEEDED");
  assert.ok(quota instanceof ChaiStorageError);

  const other = classifyError(new Error("something else"));
  assert.equal(other.code, "WRITE_FAILED");
});

test("createChromeSyncAdapter refuses to build without an area", () => {
  assert.throws(() => createChromeSyncAdapter(null), /not available/);
});

test("writeRules stores one key per rule plus an index", async () => {
  const { adapter, store } = newStore();
  await store.writeRules([
    { id: "a", name: "A", css: "body{}" },
    { id: "b", name: "B", css: "p{}" },
  ]);

  assert.ok(adapter.data[RULE_PREFIX + "a"]);
  assert.ok(adapter.data[RULE_PREFIX + "b"]);
  assert.deepEqual(adapter.data[INDEX_KEY], { ids: ["a", "b"] });
  // The old single-blob layout must no longer be used.
  assert.equal(adapter.data.chai_rules, undefined);
});

test("writeRules accepts payloads far larger than the old 8 KB single-key cap", async () => {
  const { adapter, store } = newStore();
  // 10 rules of 4 KB each = 40 KB, impossible under one 8 KB key.
  const rules = Array.from({ length: 10 }, (_, i) => ({
    id: `big-${i}`,
    name: `Big ${i}`,
    css: `/* ${"x".repeat(4096)} */`,
  }));
  await store.writeRules(rules);
  assert.equal(Object.keys(adapter.data).filter((k) => k.startsWith(RULE_PREFIX)).length, 10);
});

test("writeRules rejects a single rule over the per-item budget", async () => {
  const { store } = newStore();
  await assert.rejects(
    () => store.writeRules([{ id: "huge", name: "huge", css: "x".repeat(LIMITS.maxCssLength) }]),
    (err) => err.code === "RULE_TOO_LARGE",
  );
});

test("writeRules surfaces a quota failure as QUOTA_EXCEEDED", async () => {
  const { store } = newStore({ quotaBytes: 400 });
  await assert.rejects(
    () => store.writeRules([{ id: "a", css: "y".repeat(500) }]),
    (err) => err.code === "QUOTA_EXCEEDED",
  );
});

test("writeRules refuses more rules than the limit", async () => {
  const { store } = newStore();
  const tooMany = Array.from({ length: LIMITS.maxRules + 1 }, (_, i) => ({ id: `r${i}` }));
  await assert.rejects(() => store.writeRules(tooMany), (err) => err.code === "LIMIT_EXCEEDED");
});

test("deleting a rule leaves a tombstone instead of a silent gap", async () => {
  const { adapter, store } = newStore();
  const original = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
  await store.writeRules(original);

  await store.writeRules([original[1]], original);

  const tombstone = adapter.data[RULE_PREFIX + "a"];
  assert.equal(tombstone.deleted, true);
  assert.ok(tombstone.deletedAt > 0);
  assert.deepEqual(adapter.data[INDEX_KEY], { ids: ["b"] });
  assert.equal(adapter.data[TOMBSTONE_KEY].some((t) => t.id === "a"), true);
});

test("writeRules adopts a rule created concurrently on another device", async () => {
  const { adapter, store } = newStore();
  await store.writeRules([{ id: "a", name: "A" }]);

  // Another device adds "b" while we were editing.
  adapter.setData({ ...adapter.data, [RULE_PREFIX + "b"]: { id: "b", name: "B", css: "", updatedAt: 1 } });

  await store.writeRules([{ id: "a", name: "A2" }], [{ id: "a", name: "A" }]);

  assert.ok(adapter.data[RULE_PREFIX + "a"]);
  assert.ok(adapter.data[RULE_PREFIX + "b"], "concurrent rule must be preserved");
  assert.deepEqual(adapter.data[INDEX_KEY], { ids: ["a", "b"] });
});

test("readState recovers a rule that is missing from the index", async () => {
  const { adapter, store } = newStore();
  adapter.setData({ [RULE_PREFIX + "orphan"]: { id: "orphan", name: "O", css: "" } });

  const state = await store.readState();
  assert.equal(state.rules.has("orphan"), true);
});

test("setGlobalEnabled persists the flag and defaults to on when absent", async () => {
  const { adapter, store } = newStore();
  assert.equal((await store.readState()).globalEnabled, true);

  await store.setGlobalEnabled(false);
  assert.equal(adapter.data.chai_global_enabled, false);
  assert.equal((await store.readState()).globalEnabled, false);
});

test("usage reports byte, rule and tombstone counts", async () => {
  const { store } = newStore();
  await store.writeRules([{ id: "a", name: "A" }, { id: "b", name: "B" }]);
  const usage = await store.usage();
  assert.equal(usage.ruleCount, 2);
  assert.ok(usage.bytes > 0);
  assert.equal(typeof usage.tombstoneCount, "number");
});

// ── Legacy migration ────────────────────────────────────────
test("migrateLegacy moves the old array into per-rule keys and removes it", async () => {
  const { adapter, store } = newStore();
  adapter.setData({
    [LEGACY_KEY]: [
      { id: "old-1", name: "Old 1", css: "a{}" },
      { id: "old-2", name: "Old 2", css: "b{}" },
    ],
  });

  const result = await store.migrateLegacy();
  assert.equal(result.migrated, 2);
  assert.equal(adapter.data[LEGACY_KEY], undefined);
  assert.ok(adapter.data[RULE_PREFIX + "old-1"]);
  assert.deepEqual(adapter.data[INDEX_KEY], { ids: ["old-1", "old-2"] });
});

test("migrateLegacy is idempotent and skips unusable entries", async () => {
  const { adapter, store } = newStore();
  adapter.setData({ [LEGACY_KEY]: [{ id: "keep", css: "a{}" }, { whitelist: "bad" }] });

  assert.equal((await store.migrateLegacy()).migrated, 1);
  assert.deepEqual((await store.migrateLegacy()).migrated, 0);
  assert.ok(adapter.data[RULE_PREFIX + "keep"]);
});

test("migrateLegacy does nothing when there is no legacy key", async () => {
  const { store } = newStore();
  assert.equal((await store.migrateLegacy()).migrated, 0);
});

// ── Reactive store ──────────────────────────────────────────
function newRuleStore(options = {}) {
  const adapter = createFakeAdapter(options);
  installChromeStub(adapter);
  const errors = [];
  const ruleStore = createRuleStore({ store: createStore(adapter), onError: (err) => errors.push(err) });
  return { adapter, ruleStore, errors };
}

test("ruleStore.addRule persists through the store and notifies subscribers", async () => {
  const { adapter, ruleStore } = newRuleStore();
  const seen = [];
  ruleStore.subscribe((snapshot) => seen.push(snapshot.rules.length));

  await ruleStore.addRule({ name: "First", css: "body{}" });

  assert.equal(adapter.data[INDEX_KEY].ids.length, 1);
  assert.ok(seen.includes(1));
  assert.equal(ruleStore.snapshot().rules[0].name, "First");
});

test("ruleStore.updateRule rejects an unknown id", async () => {
  const { ruleStore } = newRuleStore();
  await assert.rejects(() => ruleStore.updateRule("missing", { name: "x" }), /No rule with id/);
});

test("ruleStore.updateRule refuses an unsafe regex", async () => {
  const { ruleStore } = newRuleStore();
  const created = await ruleStore.addRule({ name: "r", css: "" });
  await assert.rejects(
    () => ruleStore.updateRule(created.rules[0].id, { whitelist: [{ matchType: "regex", value: "(a+)+" }] }),
    (err) => err.code === "INVALID_RULE",
  );
});

test("ruleStore.deleteRule removes the rule and keeps a tombstone", async () => {
  const { adapter, ruleStore } = newRuleStore();
  const created = await ruleStore.addRule({ name: "gone", css: "" });
  const id = created.rules[0].id;

  const after = await ruleStore.deleteRule(id);
  assert.equal(after.rules.length, 0);
  assert.equal(adapter.data[RULE_PREFIX + id].deleted, true);
});

test("ruleStore applies a change pushed by another device", async () => {
  const { adapter, ruleStore } = newRuleStore();
  await ruleStore.load();

  adapter.pushExternal({
    [RULE_PREFIX + "remote"]: { id: "remote", name: "Remote", css: "p{}", updatedAt: 5 },
    [INDEX_KEY]: { ids: ["remote"] },
  });

  const rules = ruleStore.snapshot().rules;
  assert.equal(rules.length, 1);
  assert.equal(rules[0].name, "Remote");
});

test("ruleStore.setGlobalEnabled rolls back the optimistic value on failure", async () => {
  const adapter = createFakeAdapter();
  installChromeStub(adapter);
  const errors = [];
  const ruleStore = createRuleStore({ store: createStore(adapter), onError: (err) => errors.push(err) });
  await ruleStore.load();

  adapter.set = async () => {
    throw new Error("QUOTA_BYTES quota exceeded");
  };

  await assert.rejects(() => ruleStore.setGlobalEnabled(false), (err) => err.code === "QUOTA_EXCEEDED");
  assert.equal(ruleStore.snapshot().globalEnabled, true, "state must roll back");
  assert.equal(errors.length, 1);
});

test("ruleStore.syncNow reconciles with what is actually stored", async () => {
  const { adapter, ruleStore } = newRuleStore();
  await ruleStore.load();

  adapter.setData({
    [RULE_PREFIX + "z"]: { id: "z", name: "Z", css: "", updatedAt: 9 },
    [INDEX_KEY]: { ids: ["z"] },
  });

  const snapshot = await ruleStore.syncNow();
  assert.equal(snapshot.rules.length, 1);
  assert.equal(snapshot.rules[0].id, "z");
});

test("ruleStore rejects writes past the rule limit", async () => {
  const { adapter, ruleStore } = newRuleStore();
  const seeded = {};
  const ids = [];
  for (let i = 0; i < LIMITS.maxRules; i += 1) {
    const id = `r${i}`;
    ids.push(id);
    seeded[RULE_PREFIX + id] = { id, name: id, css: "", updatedAt: 1 };
  }
  seeded[INDEX_KEY] = { ids };
  adapter.setData(seeded);

  await ruleStore.load();
  assert.equal(ruleStore.snapshot().rules.length, LIMITS.maxRules);
  await assert.rejects(() => ruleStore.addRule({ name: "one too many" }), (err) => err.code === "LIMIT_EXCEEDED");
});

// ── Cross-device behaviour ──────────────────────────────────
test("a deletion propagates to the other device through the tombstone", async () => {
  const { adapter, ruleStore } = newRuleStore();
  const created = await ruleStore.addRule({ name: "doomed", css: "body{}" });
  const id = created.rules[0].id;
  await ruleStore.deleteRule(id);

  // The second device sees exactly what sync delivered: a tombstone, not a gap.
  const tombstone = adapter.data[RULE_PREFIX + id];
  assert.equal(tombstone.deleted, true);

  const second = createRuleStore({ store: createStore(adapter), onError: () => {} });
  const snapshot = await second.load();
  assert.equal(snapshot.rules.length, 0);
});

test("an offline edit does not resurrect a rule deleted on another device", async () => {
  const { adapter, ruleStore } = newRuleStore();
  await ruleStore.load();

  // Device A deleted the rule at t=1000.
  adapter.pushExternal({
    [RULE_PREFIX + "shared"]: { id: "shared", deleted: true, deletedAt: 1000 },
    [TOMBSTONE_KEY]: [{ id: "shared", deleted: true, deletedAt: 1000 }],
  });

  // Device B comes back online with an edit made at t=500.
  adapter.pushExternal({
    [RULE_PREFIX + "shared"]: { id: "shared", name: "stale", css: "", updatedAt: 500 },
  });

  assert.equal(ruleStore.snapshot().rules.length, 0);
});

test("a rule added on another device appears in the snapshot and notifies subscribers", async () => {
  const { adapter, ruleStore } = newRuleStore();
  await ruleStore.load();

  const seen = [];
  ruleStore.subscribe((snapshot) => seen.push(snapshot.rules.map((r) => r.name)));

  adapter.pushExternal({
    [RULE_PREFIX + "remote"]: { id: "remote", name: "From laptop", css: "p{}", updatedAt: 42 },
    [INDEX_KEY]: { ids: ["remote"] },
  });

  assert.deepEqual(ruleStore.snapshot().rules.map((r) => r.name), ["From laptop"]);
  assert.ok(seen.some((names) => names.includes("From laptop")));
});

test("dispose stops listening for remote changes", async () => {
  const { adapter, ruleStore } = newRuleStore();
  await ruleStore.load();
  ruleStore.dispose();

  adapter.pushExternal({
    [RULE_PREFIX + "late"]: { id: "late", name: "Late", css: "", updatedAt: 7 },
  });

  assert.equal(ruleStore.snapshot().rules.length, 0);
});

