const STORAGE_KEY = "chai_rules";
const GLOBAL_ENABLED_KEY = "chai_global_enabled";

function testEntry(entry, url, hostname) {
  if (entry.matchType === "domain") {
    return hostname === entry.value || hostname.endsWith("." + entry.value);
  } else if (entry.matchType === "regex") {
    try { return new RegExp(entry.value).test(url); } catch { return false; }
  }
  return false;
}

function ruleMatches(rule, url, hostname) {
  const wl = rule.whitelist || [];
  const bl = rule.blacklist || [];
  if (wl.length > 0 && !wl.some(e => testEntry(e, url, hostname))) return false;
  if (bl.some(e => testEntry(e, url, hostname))) return false;
  return true;
}

async function applyRules() {
  const result = await chrome.storage.sync.get([STORAGE_KEY, GLOBAL_ENABLED_KEY]);
  const rules = result[STORAGE_KEY] || [];
  const globalEnabled = result[GLOBAL_ENABLED_KEY] !== false;

  document.querySelectorAll("style[id^='chai-']").forEach(el => el.remove());

  if (!globalEnabled) return;

  const url = window.location.href;
  const hostname = window.location.hostname;

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!ruleMatches(rule, url, hostname)) continue;

    const style = document.createElement("style");
    style.id = `chai-${rule.id}`;
    style.textContent = rule.css;
    document.documentElement.appendChild(style);
  }
}

applyRules();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && (changes[STORAGE_KEY] || changes[GLOBAL_ENABLED_KEY])) {
    applyRules();
  }
});
