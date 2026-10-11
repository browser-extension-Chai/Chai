import test from "node:test";
import assert from "node:assert/strict";

import {
  GLOBAL_ENABLED_KEY,
  INDEX_KEY,
  LIMITS,
  RULE_PREFIX,
  TOMBSTONE_KEY,
  byteSize,
  checkRegex,
  clampText,
  createRuleId,
  mergeIncoming,
  normalizeRule,
  normalizeRules,
  ruleMatches,
  testEntry,
} from "../src/shared/rules.js";

test("clampText keeps surrogate pairs intact", () => {
  // "😀" is two UTF-16 units; clamping to 3 must not emit a lone surrogate.
  const text = "ab😀cd";
  const clamped = clampText(text, 3);
  assert.equal(clamped, "ab");
  assert.equal(clamped.length % 2 === 0 || !/[\uD800-\uDFFF]/.test(clamped.slice(-1)), true);
});

test("clampText truncates plain text to the limit", () => {
  assert.equal(clampText("abcdef", 4), "abcd");
  assert.equal(clampText("abc", 10), "abc");
  assert.equal(clampText(undefined, 4), "");
});

test("byteSize measures UTF-8 length of the JSON encoding", () => {
  assert.equal(byteSize("a"), 3); // "a" -> 3 bytes with quotes
  assert.ok(byteSize("😀") > byteSize("a"));
});

test("checkRegex rejects invalid, empty and oversized patterns", () => {
  assert.equal(checkRegex(".*").ok, true);
  assert.equal(checkRegex("").ok, false);
  assert.equal(checkRegex("(").ok, false);
  assert.equal(checkRegex("a".repeat(LIMITS.maxMatchValueLength + 1)).ok, false);
});

test("checkRegex rejects nested quantifiers that backtrack catastrophically", () => {
  assert.equal(checkRegex("(a+)+$").ok, false);
  assert.equal(checkRegex("(a*)*b").ok, false);
  assert.equal(checkRegex("(ab)+c").ok, true);
});

test("createRuleId produces distinct UUIDs", () => {
  const ids = new Set(Array.from({ length: 50 }, () => createRuleId()));
  assert.equal(ids.size, 50);
});

test("normalizeRule fills defaults and stamps updatedAt", () => {
  const { rule, error } = normalizeRule({ name: "x" }, { now: 1234 });
  assert.equal(error, undefined);
  assert.equal(rule.name, "x");
  assert.equal(rule.enabled, true);
  assert.deepEqual(rule.whitelist, []);
  assert.equal(rule.updatedAt, 1234);
  assert.ok(rule.id);
});

test("normalizeRule preserves an incoming id and can be forced to a new one", () => {
  assert.equal(normalizeRule({ id: "stable", name: "a" }).rule.id, "stable");
  assert.equal(normalizeRule({ id: "stable", name: "a" }, { id: "forced" }).rule.id, "forced");
  assert.ok(normalizeRule({ name: "a" }).rule.id);
});

test("normalizeRule refuses malformed input", () => {
  assert.ok(normalizeRule(null).error);
  assert.ok(normalizeRule({ whitelist: "nope" }).error);
  assert.ok(normalizeRule({ whitelist: [{ matchType: "regex", value: "(a+)+" }] }).error);
});

test("normalizeRule drops unusable match entries and non-object rules", () => {
  const { rule } = normalizeRule({
    whitelist: [
      { matchType: "domain", value: "example.com" },
      { matchType: "bogus", value: "example.com" },
      { matchType: "domain", value: "   " },
      "not an object",
      null,
    ],
  });
  assert.deepEqual(rule.whitelist, [{ matchType: "domain", value: "example.com" }]);
});

test("normalizeRule caps the CSS payload", () => {
  const { rule } = normalizeRule({ css: "x".repeat(LIMITS.maxCssLength + 500) });
  assert.equal(rule.css.length, LIMITS.maxCssLength);
});

test("normalizeRules reissues duplicate ids so imports cannot hijack a rule", () => {
  const { rules } = normalizeRules([
    { id: "same", name: "a" },
    { id: "same", name: "b" },
  ]);
  assert.equal(rules.length, 2);
  assert.notEqual(rules[0].id, rules[1].id);
});

test("normalizeRules rejects non-arrays, empty arrays and oversized batches", () => {
  assert.ok(normalizeRules({}).error);
  assert.ok(normalizeRules([]).error);
  assert.ok(normalizeRules(new Array(LIMITS.maxRules + 1).fill({})).error);
});

test("normalizeRules reports which rule failed", () => {
  const result = normalizeRules([{ name: "ok" }, { whitelist: [{ matchType: "regex", value: "(" }] }]);
  assert.match(result.error, /rule #2/);
});

test("testEntry matches domains and subdomains but not lookalikes", () => {
  const entry = { matchType: "domain", value: "example.com" };
  assert.equal(testEntry(entry, "https://example.com/", "example.com"), true);
  assert.equal(testEntry(entry, "https://a.example.com/", "a.example.com"), true);
  assert.equal(testEntry(entry, "https://notexample.com/", "notexample.com"), false);
});

test("testEntry applies regexes to the full URL", () => {
  const entry = { matchType: "regex", value: "^https://example\\.com/" };
  assert.equal(testEntry(entry, "https://example.com/x", "example.com"), true);
  assert.equal(testEntry(entry, "https://other.com/", "other.com"), false);
});

test("testEntry survives a broken regex instead of throwing", () => {
  assert.equal(testEntry({ matchType: "regex", value: "(" }, "https://x/", "x"), false);
});

test("ruleMatches requires a whitelist hit and honours the blacklist", () => {
  const base = { enabled: true, whitelist: [{ matchType: "domain", value: "example.com" }] };
  assert.equal(ruleMatches(base, "https://example.com/", "example.com"), true);
  assert.equal(ruleMatches({ ...base, enabled: false }, "https://example.com/", "example.com"), false);
  assert.equal(ruleMatches({ ...base, whitelist: [] }, "https://example.com/", "example.com"), false);
  assert.equal(
    ruleMatches({ ...base, blacklist: [{ matchType: "domain", value: "example.com" }] }, "https://example.com/", "example.com"),
    false,
  );
});

// ── mergeIncoming ───────────────────────────────────────────
function makeRule(id, updatedAt, extra = {}) {
  return { id, name: id, enabled: true, whitelist: [], blacklist: [], css: "", updatedAt, ...extra };
}

function localState(ruleList, tombstones = []) {
  return {
    rules: new Map(ruleList.map((entry) => [entry.id, entry])),
    index: { ids: ruleList.map((entry) => entry.id) },
    tombstones,
  };
}

test("mergeIncoming applies a newer remote rule", () => {
  const merged = mergeIncoming(localState([makeRule("a", 1)]), { [RULE_PREFIX + "a"]: makeRule("a", 5, { css: "new" }) });
  assert.equal(merged.rules.get("a").css, "new");
});

test("mergeIncoming ignores a stale remote rule", () => {
  const merged = mergeIncoming(localState([makeRule("a", 9)]), { [RULE_PREFIX + "a"]: makeRule("a", 2, { css: "old" }) });
  assert.equal(merged.rules.get("a").updatedAt, 9);
});

test("mergeIncoming adopts a rule deleted elsewhere and drops its tombstone on rebirth", () => {
  const deleted = mergeIncoming(localState([makeRule("a", 1)]), {
    [RULE_PREFIX + "a"]: { id: "a", deleted: true, deletedAt: 10 },
  });
  assert.equal(deleted.rules.has("a"), false);
  assert.equal(deleted.tombstones.get("a"), 10);

  const reborn = mergeIncoming(deleted, { [RULE_PREFIX + "a"]: makeRule("a", 11) });
  assert.equal(reborn.rules.has("a"), true);
  assert.equal(reborn.tombstones.has("a"), false);
});

test("mergeIncoming does not let an offline edit resurrect a newer deletion", () => {
  const merged = mergeIncoming(
    localState([], [["a", 100]]),
    { [RULE_PREFIX + "a"]: makeRule("a", 50) },
  );
  assert.equal(merged.rules.has("a"), false);
});

test("mergeIncoming drops an old orphan the incoming index excludes", () => {
  // The index has no timestamp, so a rule it excludes is treated as removed only
  // once it is too old to be a concurrent insert.
  const merged = mergeIncoming(
    localState([makeRule("a", 1), makeRule("b", 1)]),
    { [INDEX_KEY]: { ids: ["a"] } },
    { now: 1_000_000 },
  );
  assert.deepEqual([...merged.rules.keys()], ["a"]);
  assert.deepEqual(merged.index, { ids: ["a"] });
});

test("mergeIncoming protects a just-added rule from a stale index", () => {
  const merged = mergeIncoming(
    localState([makeRule("fresh", 1_000_000)]),
    { [INDEX_KEY]: { ids: [] } },
    { now: 1_000_000 },
  );
  assert.deepEqual([...merged.rules.keys()], ["fresh"]);
});

test("mergeIncoming leaves the local set alone when no index is in the batch", () => {
  const merged = mergeIncoming(localState([makeRule("a", 1)]), {
    [TOMBSTONE_KEY]: [],
  });
  assert.deepEqual([...merged.rules.keys()], ["a"]);
});

test("mergeIncoming never treats metadata keys as rules", () => {
  const merged = mergeIncoming(localState([makeRule("a", 1)]), {
    [INDEX_KEY]: { ids: ["a"] },
    [TOMBSTONE_KEY]: [],
  });
  assert.deepEqual([...merged.rules.keys()], ["a"]);
  assert.equal(merged.tombstones.size, 0);
});

test("mergeIncoming merges tombstone lists monotonically", () => {
  const merged = mergeIncoming(localState([], [["x", 5]]), {
    [TOMBSTONE_KEY]: [
      { id: "x", deleted: true, deletedAt: 2 },
      { id: "y", deleted: true, deletedAt: 7 },
    ],
  });
  assert.equal(merged.tombstones.get("x"), 5);
  assert.equal(merged.tombstones.get("y"), 7);
});

test("mergeIncoming treats a removed key as a deletion", () => {
  const merged = mergeIncoming(localState([makeRule("a", 1)]), { [RULE_PREFIX + "a"]: undefined });
  assert.equal(merged.rules.has("a"), false);
});

test("mergeIncoming ignores settings keys", () => {
  const state = localState([makeRule("a", 1)]);
  const merged = mergeIncoming(state, { [GLOBAL_ENABLED_KEY]: false });
  assert.equal(merged.rules.size, 1);
});
