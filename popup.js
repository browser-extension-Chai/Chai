import { createRuleStore } from "./src/shared/ruleStore.js";
import { ruleMatches } from "./src/shared/rules.js";

const store = createRuleStore({ onError: (err) => showError(err.message) });

let currentUrl = "";
let currentHostname = "";
let snapshot = { rules: [], globalEnabled: true };

// ── Safe DOM helpers ────────────────────────────────────────
// Rule names and match values are user/import controlled, so the popup builds
// nodes explicitly instead of interpolating them into markup.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderStats() {
  const enabledCount = snapshot.rules.filter((r) => r.enabled).length;
  document.getElementById("statsText").textContent =
    `${enabledCount} rule${enabledCount !== 1 ? "s" : ""} enabled`;
}

function renderCurrentRules() {
  const container = document.getElementById("currentRules");
  container.replaceChildren();

  // Deliberately ignores `enabled`: the popup lists every rule that governs this
  // page, including the ones currently switched off.
  const matches = snapshot.rules.filter((rule) =>
    ruleMatches({ ...rule, enabled: true }, currentUrl, currentHostname),
  );

  if (matches.length === 0) {
    container.append(el("div", "empty-message", "No rules match this page"));
    return;
  }

  for (const rule of matches) {
    const item = el("div", `rule-item-popup${rule.enabled ? "" : " disabled"}`);

    const name = el("span", "rule-name-popup", rule.name || "Untitled");
    name.title = rule.name || "Untitled";

    const label = el("label", "toggle rule-toggle-popup");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = rule.enabled;
    input.dataset.id = rule.id;
    input.setAttribute("aria-label", `Toggle ${rule.name || "rule"} on this page`);
    input.addEventListener("change", async () => {
      input.disabled = true;
      try {
        await store.updateRule(rule.id, { enabled: input.checked });
      } catch (err) {
        input.checked = !input.checked;
        showError(err.message);
      } finally {
        input.disabled = false;
      }
    });

    label.append(input, el("span", "toggle-slider"));
    item.append(name, label);
    container.append(item);
  }
}

// ── Error surface ───────────────────────────────────────────
function showError(message) {
  const banner = document.getElementById("errorBanner");
  if (!banner) return;
  banner.textContent = message;
  banner.hidden = false;
}

function hideError() {
  const banner = document.getElementById("errorBanner");
  if (banner) banner.hidden = true;
}

/** The service worker records the last persistent failure for the popup to show. */
async function readBackgroundError() {
  try {
    const stored = await chrome.storage.session?.get?.("chai_last_error");
    const last = stored?.chai_last_error;
    if (!last) return;
    const age = Date.now() - (last.at || 0);
    if (age < 24 * 60 * 60 * 1000) showError(last.message);
  } catch {
    // storage.session may be unavailable; the badge would still be set.
  }
}

// ── Init ────────────────────────────────────────────────────
function describeTab(tab) {
  const url = tab?.url || "";
  if (!url) return { url: "", hostname: "" };
  try {
    const parsed = new URL(url);
    // Restricted pages (chrome://, edge://, about:, extension pages) cannot be
    // styled by content scripts; report an empty hostname rather than throwing.
    if (!/^https?:$/.test(parsed.protocol)) return { url: "", hostname: "" };
    return { url, hostname: parsed.hostname };
  } catch {
    return { url: "", hostname: "" };
  }
}

async function init() {
  hideError();
  await readBackgroundError();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    ({ url: currentUrl, hostname: currentHostname } = describeTab(tab));
  } catch {
    currentUrl = "";
    currentHostname = "";
  }

  const globalToggle = document.getElementById("globalToggle");
  globalToggle.addEventListener("change", async () => {
    globalToggle.disabled = true;
    try {
      await store.setGlobalEnabled(globalToggle.checked);
    } catch (err) {
      globalToggle.checked = !globalToggle.checked;
      showError(err.message);
    } finally {
      globalToggle.disabled = false;
    }
  });

  document.getElementById("openOptions").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  store.subscribe((next) => {
    snapshot = next;
    globalToggle.checked = next.globalEnabled;
    renderStats();
    renderCurrentRules();
  }, { immediate: false });

  try {
    snapshot = await store.load();
    globalToggle.checked = snapshot.globalEnabled;
    renderStats();
    renderCurrentRules();
  } catch (err) {
    showError(`Could not read synced settings: ${err.message}`);
    renderStats();
    renderCurrentRules();
  }
}

init();
