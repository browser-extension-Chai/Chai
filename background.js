import { createRuleStore } from "./src/shared/ruleStore.js";
import { ChaiStorageError } from "./src/shared/storage.js";

const DARK_MODE_CSS = `/* Dark mode — invert colors and fix images/videos */
html {
  filter: invert(100%) hue-rotate(180deg);
}

img,
video,
canvas,
picture,
[style*="background-image"] {
  filter: invert(100%) hue-rotate(180deg);
}`;

const ERROR_BADGE = "!";

/**
 * Default rules are keyed by a stable id so that two devices installing around
 * the same time converge on one record instead of writing separate copies.
 */
const DEFAULT_RULES = [
  {
    id: "chai-default-dark-mode",
    name: "Dark Mode",
    enabled: true,
    whitelist: [{ matchType: "regex", value: ".*" }],
    blacklist: [],
    css: DARK_MODE_CSS,
  },
];

function describeError(err) {
  if (err instanceof ChaiStorageError) return { code: err.code, message: err.message };
  return { code: "UNKNOWN", message: String(err?.message || err) };
}

/** Surface a storage failure in the toolbar; the popup re-reads it to show details. */
async function flagError(err) {
  const { code, message } = describeError(err);
  try {
    await chrome.storage.session?.set?.({ chai_last_error: { code, message, at: Date.now() } });
  } catch {
    // storage.session needs no extra permission on MV3; ignore if unavailable.
  }
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
    await chrome.action.setBadgeText({ text: ERROR_BADGE });
  } catch {
    // Badge is cosmetic.
  }
}

export async function clearErrorFlag() {
  try {
    await chrome.storage.session?.remove?.("chai_last_error");
  } catch {
    // Ignore.
  }
  try {
    await chrome.action.setBadgeText({ text: "" });
  } catch {
    // Ignore.
  }
}

const store = createRuleStore({ onError: flagError });

const ready = (async () => {
  try {
    await store.migrateLegacy();
    await store.load();
  } catch (err) {
    await flagError(err);
  }
})();

chrome.runtime.onInstalled.addListener(async (details) => {
  await ready;
  if (details.reason !== "install" && details.reason !== "update") return;

  try {
    const { rules } = store.snapshot();
    const hasDefault = rules.some((rule) => rule.id === DEFAULT_RULES[0].id);
    if (!hasDefault) {
      // Seed only when the account has nothing at all; an empty rule list after
      // a deliberate delete must stay empty.
      const neverConfigured = rules.length === 0 && details.reason === "install";
      if (neverConfigured) await store.addRule(DEFAULT_RULES[0]);
    }
    await clearErrorFlag();
  } catch (err) {
    await flagError(err);
  }
});

/** Keep the badge honest when another device resolves the problem. */
chrome.storage.session?.onChanged?.addListener((changes, area) => {
  if (area !== "session") return;
  if ("chai_last_error" in changes && !changes.chai_last_error.newValue) {
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
  }
});

export { store };
