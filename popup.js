const STORAGE_KEY = "chai_rules";
const GLOBAL_ENABLED_KEY = "chai_global_enabled";

let rules = [];
let globalEnabled = true;
let currentUrl = "";
let currentHostname = "";

// Test if entry matches current page
function testEntry(entry) {
  if (entry.matchType === "domain") {
    return currentHostname === entry.value || currentHostname.endsWith("." + entry.value);
  } else if (entry.matchType === "regex") {
    try { return new RegExp(entry.value).test(currentUrl); } catch { return false; }
  }
  return false;
}

// Check if rule matches current page
function ruleMatchesCurrentPage(rule) {
  const wl = rule.whitelist || [];
  const bl = rule.blacklist || [];
  if (wl.length === 0) return false;
  if (!wl.some(testEntry)) return false;
  if (bl.some(testEntry)) return false;
  return true;
}

// Render stats
function renderStats() {
  const enabledCount = rules.filter(r => r.enabled).length;
  document.getElementById("statsText").textContent = `${enabledCount} rule${enabledCount !== 1 ? "s" : ""} enabled`;
}

// Render current page rules
function renderCurrentRules() {
  const container = document.getElementById("currentRules");
  const matchingRules = rules.filter(ruleMatchesCurrentPage);

  if (matchingRules.length === 0) {
    container.innerHTML = '<div class="empty-message">No rules match this page</div>';
    return;
  }

  container.innerHTML = matchingRules.map(rule => `
    <div class="rule-item-popup ${rule.enabled ? "" : "disabled"}">
      <span class="rule-name-popup">${rule.name || "Untitled"}</span>
      <label class="toggle rule-toggle-popup">
        <input type="checkbox" ${rule.enabled ? "checked" : ""} data-id="${rule.id}">
        <span class="toggle-slider"></span>
      </label>
    </div>
  `).join("");

  container.querySelectorAll("input[type=checkbox]").forEach(input => {
    input.addEventListener("change", async () => {
      const rule = rules.find(r => r.id === input.dataset.id);
      if (rule) {
        rule.enabled = input.checked;
        await chrome.storage.sync.set({ [STORAGE_KEY]: rules });
        renderStats();
      }
    });
  });
}

// Init
async function init() {
  // Get current tab URL
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentUrl = tab.url;
  currentHostname = new URL(tab.url).hostname;

  // Load rules and global state
  const result = await chrome.storage.sync.get([STORAGE_KEY, GLOBAL_ENABLED_KEY]);
  rules = result[STORAGE_KEY] || [];
  globalEnabled = result[GLOBAL_ENABLED_KEY] !== false;

  // Set global toggle
  document.getElementById("globalToggle").checked = globalEnabled;

  // Render
  renderStats();
  renderCurrentRules();

  // Global toggle handler
  document.getElementById("globalToggle").addEventListener("change", async (e) => {
    globalEnabled = e.target.checked;
    await chrome.storage.sync.set({ [GLOBAL_ENABLED_KEY]: globalEnabled });
  });

  // Open options button
  document.getElementById("openOptions").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
}

init();

