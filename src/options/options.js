import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { standardKeymap, historyKeymap, history, indentWithTab, copyLineDown, deleteLine, moveLineUp, moveLineDown } from "@codemirror/commands";
import { selectNextOccurrence } from "@codemirror/search";
import { css } from "@codemirror/lang-css";
import { oneDark } from "@codemirror/theme-one-dark";
import { createRuleStore } from "../shared/ruleStore.js";
import { byteSize, checkRegex, createRuleId, normalizeRules } from "../shared/rules.js";

const store = createRuleStore({ onError: (err) => showToast(err.message, "error") });

let editorView;
let currentRuleId = null;
let rules = [];
let autoSaveTimer = null;
let initialRuleState = null;
let conflictNotified = false;
let bootstrapped = false;
let suppressDocListener = false;

const matchState = [];

// Custom keybindings
const customKeys = [
  { key: "Ctrl-s", preventDefault: true, run: () => { saveCurrentRule(); return true; }},
  { key: "Shift-Alt-f", preventDefault: true, run: (view) => { formatCSS(view); return true; }},
  { key: "Ctrl-Shift-d", run: copyLineDown },
  { key: "Ctrl-Shift-k", run: deleteLine },
  { key: "Ctrl-Shift-ArrowUp", run: moveLineUp },
  { key: "Ctrl-Shift-ArrowDown", run: moveLineDown },
  { key: "Ctrl-d", preventDefault: true, run: selectNextOccurrence },
  { key: "Ctrl-Enter", run: (view) => {
    const { state } = view;
    const line = state.doc.lineAt(state.selection.main.head);
    view.dispatch({ changes: { from: line.to, insert: "\n" } });
    return true;
  }},
  { key: "Ctrl-Shift-Enter", run: (view) => {
    const { state } = view;
    const line = state.doc.lineAt(state.selection.main.head);
    view.dispatch({ changes: { from: line.from, insert: "\n" }, selection: { anchor: line.from } });
    return true;
  }},
];

// Editor theme
const editorTheme = EditorView.theme({
  "&": { padding: "12px" },
  ".cm-scroller": { overflow: "auto" },
});

// ── Feedback ────────────────────────────────────────────────
let toastTimer = null;

function showToast(message, kind = "info", duration = 1800) {
  const toast = document.getElementById("saveToast");
  if (!toast) return;
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.classList.toggle("is-error", kind === "error");
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), duration);
}

// ── Editor ──────────────────────────────────────────────────
function formatCSS(view) {
  const raw = view.state.doc.toString();
  const indent = "  ";
  let out = "";
  let depth = 0;
  // Tokenize: strings, comments, braces, semicolons, everything else
  const tokens = raw.match(/\/\*[\s\S]*?\*\/|"[^"]*"|'[^']*'|[{}]|[^{}]+/g) || [];
  for (let tok of tokens) {
    tok = tok.trim();
    if (!tok) continue;
    if (tok === "{") {
      out = out.trimEnd() + " {\n";
      depth++;
    } else if (tok === "}") {
      depth = Math.max(0, depth - 1);
      out += indent.repeat(depth) + "}\n\n";
    } else if (tok.startsWith("/*")) {
      // comment — preserve, indent
      const lines = tok.split("\n").map((l, i) => (i === 0 ? indent.repeat(depth) + l.trim() : indent.repeat(depth) + " " + l.trim())).join("\n");
      out += lines + "\n";
    } else {
      // declarations or selectors
      const parts = tok.split(";").map(s => s.trim()).filter(Boolean);
      if (depth > 0) {
        // inside a rule: each declaration on its own line
        for (const p of parts) out += indent.repeat(depth) + p + ";\n";
      } else {
        // selector / at-rule
        for (const p of parts) {
          const s = p.trim();
          if (s) out += indent.repeat(depth) + s + "\n";
        }
      }
    }
  }
  out = out.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  if (out === raw) return;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: out },
  });
  scheduleSave(500);
}

function initEditor() {
  editorView = new EditorView({
    state: EditorState.create({
      extensions: [
        css(),
        oneDark,
        lineNumbers(),
        history(),
        keymap.of([...customKeys, ...standardKeymap, ...historyKeymap, indentWithTab]),
        EditorView.lineWrapping,
        editorTheme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !suppressDocListener) {
            scheduleSave(600);
          }
        }),
      ],
    }),
    parent: document.getElementById("editor"),
  });
}

/** Load editor contents without triggering the auto-save listener. */
function setEditorDoc(text) {
  suppressDocListener = true;
  editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: text } });
  suppressDocListener = false;
}

function scheduleSave(delay = 600) {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => saveCurrentRule(), delay);
}

// ── Match rows ────────────────────────────────────────────────
// Built with DOM APIs rather than innerHTML: rule names and match values come
// from imported JSON and must never be parsed as markup.
function renderMatchTable() {
  const container = document.getElementById("matchBody");
  container.replaceChildren();

  matchState.forEach((entry, i) => {
    const row = document.createElement("div");
    row.className = "match-row";

    const listPills = document.createElement("div");
    listPills.className = "match-pills";
    for (const [value, label, cls] of [["whitelist", "allow", "pill-white"], ["blacklist", "block", "pill-black"]]) {
      const btn = document.createElement("button");
      btn.className = `pill pill-list ${cls}${entry.list === value ? " active" : ""}`;
      btn.dataset.index = String(i);
      btn.dataset.field = "list";
      btn.dataset.val = value;
      btn.textContent = label;
      listPills.append(btn);
    }

    const typePills = document.createElement("div");
    typePills.className = "match-pills";
    for (const value of ["domain", "regex"]) {
      const btn = document.createElement("button");
      btn.className = `pill pill-type${entry.matchType === value ? " active" : ""}`;
      btn.dataset.index = String(i);
      btn.dataset.field = "type";
      btn.dataset.val = value;
      btn.textContent = value;
      typePills.append(btn);
    }

    const input = document.createElement("input");
    input.type = "text";
    input.value = entry.value;
    input.dataset.index = String(i);
    input.className = "row-value";
    input.placeholder = entry.matchType === "domain" ? "example.com" : ".*\\.example\\.com";
    if (entry.matchType === "regex" && entry.value && !checkRegex(entry.value).ok) {
      input.classList.add("row-invalid");
      input.title = checkRegex(entry.value).reason;
    }

    const remove = document.createElement("button");
    remove.className = "btn-remove-row";
    remove.dataset.index = String(i);
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Remove match row");

    row.append(listPills, typePills, input, remove);
    container.append(row);
  });

  container.querySelectorAll(".pill-list").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.index);
      matchState[i].list = btn.dataset.val;
      renderMatchTable();
      scheduleSave();
    });
  });

  container.querySelectorAll(".pill-type").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.index);
      matchState[i].matchType = btn.dataset.val;
      renderMatchTable();
      scheduleSave();
    });
  });

  container.querySelectorAll(".row-value").forEach(inp => {
    inp.addEventListener("input", () => {
      matchState[Number(inp.dataset.index)].value = inp.value;
      scheduleSave();
    });
  });

  container.querySelectorAll(".btn-remove-row").forEach(btn => {
    btn.addEventListener("click", () => {
      matchState.splice(Number(btn.dataset.index), 1);
      renderMatchTable();
      scheduleSave();
    });
  });
}

function setupMatchTable() {
  document.getElementById("addMatchBtn").addEventListener("click", () => {
    matchState.push({ list: "whitelist", matchType: "domain", value: "" });
    renderMatchTable();
  });
}

// ── Rule list ───────────────────────────────────────────────
function renderRuleList() {
  const ruleList = document.getElementById("ruleList");
  const emptyState = document.getElementById("emptyState");

  emptyState.style.display = rules.length === 0 ? "block" : "none";
  ruleList.replaceChildren();

  for (const rule of rules) {
    const item = document.createElement("div");
    item.className = `rule-item${rule.id === currentRuleId ? " active" : ""}`;
    item.dataset.id = rule.id;

    const header = document.createElement("div");
    header.className = "rule-item-header";

    const dot = document.createElement("span");
    dot.className = `rule-status-dot${rule.enabled ? " enabled" : ""}`;
    dot.dataset.id = rule.id;
    dot.title = rule.enabled ? "Enabled — click to disable" : "Disabled — click to enable";

    const name = document.createElement("span");
    name.className = "rule-item-name";
    name.textContent = rule.name || "Untitled";

    const del = document.createElement("button");
    del.className = "rule-delete-btn";
    del.dataset.id = rule.id;
    del.textContent = "×";
    del.setAttribute("aria-label", `Delete rule ${rule.name || "Untitled"}`);

    header.append(dot, name, del);
    item.append(header);
    ruleList.append(item);
  }

  const newBtn = document.createElement("button");
  newBtn.id = "newRuleBtn";
  newBtn.className = "btn-primary btn-new-rule";
  newBtn.textContent = "+ New Rule";
  ruleList.append(newBtn);

  ruleList.querySelectorAll(".rule-item").forEach(item => {
    item.addEventListener("click", (e) => {
      if (!e.target.classList.contains("rule-delete-btn") && !e.target.classList.contains("rule-status-dot")) {
        loadRule(item.dataset.id);
      }
    });
  });

  ruleList.querySelectorAll(".rule-status-dot").forEach(dot => {
    dot.addEventListener("click", async (e) => {
      e.stopPropagation();
      const rule = rules.find(r => r.id === dot.dataset.id);
      if (!rule) return;
      try {
        await store.updateRule(rule.id, { enabled: !rule.enabled });
      } catch (err) {
        showToast(err.message, "error", 4000);
      }
    });
  });

  ruleList.querySelectorAll(".rule-delete-btn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const rule = rules.find(r => r.id === btn.dataset.id);
      const isEmpty = !rule ||
        (!rule.css || rule.css.trim() === "" || rule.css.trim() === "/* Add your CSS here */") &&
        (!rule.whitelist || rule.whitelist.length === 0) &&
        (!rule.blacklist || rule.blacklist.length === 0);

      if (!isEmpty && !confirm("Delete this rule?")) return;

      try {
        if (currentRuleId === btn.dataset.id) {
          currentRuleId = null;
          document.getElementById("editorPanel").style.display = "none";
        }
        await store.deleteRule(btn.dataset.id);
      } catch (err) {
        showToast(err.message, "error", 4000);
      }
    });
  });

  newBtn.addEventListener("click", createNewRule);
}

// ── Load/Save/Delete ────────────────────────────────────────
function loadRule(id) {
  const rule = rules.find(r => r.id === id);
  if (!rule) return;

  currentRuleId = id;
  conflictNotified = false;

  const nameInput = document.getElementById("ruleName");
  nameInput.value = rule.name || "";
  nameInput.oninput = () => scheduleSave(400);

  matchState.length = 0;
  (rule.whitelist || []).forEach(entry => matchState.push({ list: "whitelist", ...entry }));
  (rule.blacklist || []).forEach(entry => matchState.push({ list: "blacklist", ...entry }));
  renderMatchTable();

  setEditorDoc(rule.css || "");

  initialRuleState = {
    name: rule.name || "",
    matches: JSON.stringify(matchState),
    css: rule.css || "",
  };

  document.getElementById("editorPanel").style.display = "flex";
  renderRuleList();
}

async function saveCurrentRule() {
  if (!currentRuleId) return;
  const rule = rules.find(r => r.id === currentRuleId);
  if (!rule) return;

  // Cancel any pending debounce: this call is that save.
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;

  const currentState = {
    name: document.getElementById("ruleName").value,
    matches: JSON.stringify(matchState),
    css: editorView.state.doc.toString(),
  };

  const hasChanged = !initialRuleState ||
    currentState.name !== initialRuleState.name ||
    currentState.matches !== initialRuleState.matches ||
    currentState.css !== initialRuleState.css;

  if (!hasChanged) return;

  const payload = {
    name: currentState.name,
    whitelist: matchState.filter(m => m.list === "whitelist").map(({ matchType, value }) => ({ matchType, value })),
    blacklist: matchState.filter(m => m.list === "blacklist").map(({ matchType, value }) => ({ matchType, value })),
    css: currentState.css,
  };

  // Refuse to persist a pattern that can hang every matched page.
  for (const entry of [...payload.whitelist, ...payload.blacklist]) {
    if (entry.matchType !== "regex") continue;
    const check = checkRegex(entry.value);
    if (!check.ok) {
      showToast(`Not saved — ${check.reason}`, "error", 5000);
      return;
    }
  }

  try {
    await store.updateRule(currentRuleId, payload);
    // The write is asynchronous, so the editor may have moved on. Only adopt the
    // saved state as the new baseline if the content still matches it; otherwise
    // re-arm the debounce so an incoming snapshot cannot roll those edits back.
    const stillMatches = document.getElementById("ruleName").value === currentState.name &&
      JSON.stringify(matchState) === currentState.matches &&
      editorView.state.doc.toString() === currentState.css;

    if (stillMatches) {
      initialRuleState = { ...currentState };
      showToast("Saved");
    } else {
      scheduleSave();
    }
  } catch (err) {
    showToast(err.message, "error", 5000);
  }
}

function createNewRule() {
  store.addRule({
    id: createRuleId(),
    name: "New Rule",
    enabled: true,
    whitelist: [],
    blacklist: [],
    css: "/* Add your CSS here */\n",
  }).catch((err) => showToast(err.message, "error", 5000));
}

// ── Remote change reconciliation ────────────────────────────
/** True when the editor holds edits that have not reached sync storage yet. */
function isEditorDirty() {
  if (!currentRuleId || !initialRuleState) return false;
  if (autoSaveTimer) return true;
  return document.getElementById("ruleName").value !== initialRuleState.name ||
    JSON.stringify(matchState) !== initialRuleState.matches ||
    editorView.state.doc.toString() !== initialRuleState.css;
}

function applySnapshot(snapshot) {
  rules = snapshot.rules;

  if (!bootstrapped) {
    renderRuleList();
    renderUsage(snapshot);
    return;
  }

  if (currentRuleId) {
    const incoming = rules.find(r => r.id === currentRuleId);

    if (!incoming) {
      currentRuleId = null;
      initialRuleState = null;
      document.getElementById("editorPanel").style.display = "none";
      showToast("This rule was deleted on another device", "info", 3000);
    } else {
      const displayed = {
        name: document.getElementById("ruleName").value,
        matches: JSON.stringify(matchState),
        css: editorView.state.doc.toString(),
      };
      const incomingState = {
        name: incoming.name || "",
        matches: JSON.stringify([
          ...(incoming.whitelist || []).map(e => ({ list: "whitelist", ...e })),
          ...(incoming.blacklist || []).map(e => ({ list: "blacklist", ...e })),
        ]),
        css: incoming.css || "",
      };

      if (incomingState.name !== displayed.name ||
          incomingState.matches !== displayed.matches ||
          incomingState.css !== displayed.css) {
        if (isEditorDirty() && !conflictNotified) {
          // Do not throw away unsaved edits; warn and let the user decide.
          conflictNotified = true;
          showToast("This rule changed on another device — press Ctrl-S to overwrite, or reopen it to discard", "error", 6000);
        } else if (!isEditorDirty()) {
          loadRule(currentRuleId);
          conflictNotified = false;
        }
      }
    }
  }

  renderRuleList();
  renderUsage(snapshot);
}

async function refreshUsage() {
  try {
    renderUsage(null, await store.usage());
  } catch {
    // Usage display is optional.
  }
}

function renderUsage(snapshot, usage = null) {
  const el = document.getElementById("storageUsage");
  if (!el) return;
  if (snapshot) {
    el.dataset.count = String(snapshot.rules.length);
  }
  if (!usage) {
    el.textContent = `${snapshot?.rules?.length ?? 0} rule(s) synced`;
    return;
  }
  const kb = (usage.bytes / 1024).toFixed(1);
  const pct = Math.min(100, Math.round((usage.bytes / (100 * 1024)) * 100));
  el.textContent = `${usage.ruleCount} rule(s) · ${kb} KB of 100 KB sync quota (${pct}%)`;
  el.classList.toggle("is-warning", pct >= 80);
  el.classList.toggle("is-error", pct >= 100);
}

// ── Export/Import ───────────────────────────────────────────
function exportRules() {
  const payload = JSON.stringify(rules, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "chai-rules.json";
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${rules.length} rule(s) · ${(byteSize(payload) / 1024).toFixed(1)} KB`, "info", 2500);
}

/** Cap remote imports; a huge body should not be read into memory unbounded. */
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

function importFromFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      showToast(`File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB; limit 2 MB)`, "error", 5000);
      return;
    }
    try {
      const parsed = JSON.parse(await file.text());
      await mergeImportedRules(parsed);
    } catch (err) {
      showToast("Invalid JSON file: " + err.message, "error", 5000);
    }
  };
  input.click();
}

function resolveImportUrl(raw) {
  let url;
  try {
    url = new URL(raw, window.location.href);
  } catch {
    return { error: "That is not a valid URL." };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    return { error: "Only https:// URLs can be imported (http:// is allowed for localhost)." };
  }
  if (url.username || url.password) {
    return { error: "URLs containing credentials are not allowed." };
  }
  return { url };
}

async function importFromUrl() {
  const raw = prompt("Enter URL to import (e.g. GitHub Gist raw URL):");
  if (!raw) return;

  const resolved = resolveImportUrl(raw.trim());
  if (resolved.error) {
    showToast(resolved.error, "error", 5000);
    return;
  }

  try {
    const res = await fetch(resolved.url, { credentials: "omit", redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_IMPORT_BYTES) {
      throw new Error(`response is too large (${(declared / 1024 / 1024).toFixed(1)} MB)`);
    }
    const text = await res.text();
    if (byteSize(text) > MAX_IMPORT_BYTES) throw new Error("response is too large");
    await mergeImportedRules(JSON.parse(text));
  } catch (err) {
    showToast("Failed to import from URL: " + err.message, "error", 5000);
  }
}

async function mergeImportedRules(imported) {
  // Fresh ids are issued for every imported rule so a hostile file cannot
  // overwrite an existing rule by reusing its id.
  const result = normalizeRules(imported, { now: Date.now() });
  if (result.error) {
    showToast("Import rejected — " + result.error, "error", 6000);
    return;
  }

  let imported_ = 0;
  const failures = [];
  for (const rule of result.rules) {
    try {
      await store.addRule(rule);
      imported_ += 1;
    } catch (err) {
      failures.push(err.message);
      break;
    }
  }

  if (failures.length > 0) {
    showToast(`Imported ${imported_} rule(s), then stopped: ${failures[0]}`, "error", 6000);
  } else {
    showToast(`Imported ${imported_} rule(s)`, "info", 2500);
  }
  await refreshUsage();
}

// ── Init ────────────────────────────────────────────────────
async function init() {
  initEditor();
  setupMatchTable();

  document.getElementById("exportBtn").addEventListener("click", exportRules);
  document.getElementById("importBtn").addEventListener("click", importFromFile);
  document.getElementById("importUrlBtn").addEventListener("click", importFromUrl);

  store.subscribe((snapshot) => applySnapshot(snapshot), { immediate: false });

  try {
    const snapshot = await store.load();
    rules = snapshot.rules;
    bootstrapped = true;
    renderRuleList();
    if (rules.length > 0) {
      loadRule(rules[0].id);
    } else {
      document.getElementById("editorPanel").style.display = "none";
    }
  } catch (err) {
    bootstrapped = true;
    showToast("Could not read synced settings: " + err.message, "error", 8000);
  }

  await refreshUsage();
  window.addEventListener("beforeunload", () => {
    clearTimeout(autoSaveTimer);
  });
}

init();
