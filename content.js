import { createRuleStore } from "./src/shared/ruleStore.js";
import { matchingRules } from "./src/shared/rules.js";

const STYLE_PREFIX = "chai-";

/**
 * Content scripts run in the page's isolated world, so injected <style> text is
 * the only thing that reaches the DOM — rule values are never interpolated into
 * markup here. Matching is delegated to the shared pure layer so the popup, the
 * service worker and this script can never disagree about what matches.
 */
const store = createRuleStore({ onError: () => {} });

function clearInjectedStyles() {
  for (const el of document.querySelectorAll(`style[id^='${STYLE_PREFIX}']`)) {
    el.remove();
  }
}

function applyRules(snapshot) {
  clearInjectedStyles();
  if (!snapshot.globalEnabled) return;

  const url = window.location.href;
  const hostname = window.location.hostname;
  const matched = matchingRules(snapshot.rules, url, hostname);

  for (const rule of matched) {
    const style = document.createElement("style");
    // Rule ids are generated as UUIDs; anything else is rejected at write time.
    // Assigning through the property (not setAttribute) keeps the value inert.
    style.id = `${STYLE_PREFIX}${String(rule.id).replace(/[^A-Za-z0-9_-]/g, "")}`;
    style.textContent = rule.css;
    document.documentElement.appendChild(style);
  }
}

let started = false;

function start(snapshot) {
  started = true;
  applyRules(snapshot);
}

store.subscribe((snapshot) => {
  // A change arriving before the first load would otherwise paint styles twice.
  if (started) applyRules(snapshot);
});

store.load().then(start).catch(() => {
  // Storage unavailable (for example sync is disabled account-wide). The page is
  // better off unstyled than broken, so fail quietly.
  clearInjectedStyles();
});
