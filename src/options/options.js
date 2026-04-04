import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { standardKeymap, historyKeymap, history, indentWithTab, copyLineDown, deleteLine, moveLineUp, moveLineDown } from "@codemirror/commands";
import { selectNextOccurrence } from "@codemirror/search";
import { css } from "@codemirror/lang-css";
import { oneDark } from "@codemirror/theme-one-dark";
import { getRules, saveRules, deleteRule } from "../shared/storage.js";

let editorView;
let currentRuleId = null;
let rules = [];
let autoSaveTimer = null;
let initialRuleState = null;

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
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => saveCurrentRule(), 800);
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
          if (update.docChanged) {
            clearTimeout(autoSaveTimer);
            autoSaveTimer = setTimeout(() => saveCurrentRule(), 1000);
          }
        }),
      ],
    }),
    parent: document.getElementById("editor"),
  });
}

// ── Match rows ────────────────────────────────────────────────
function renderMatchTable() {
  const container = document.getElementById("matchBody");
  container.innerHTML = matchState.map((entry, i) => `
    <div class="match-row">
      <div class="match-pills">
        <button class="pill pill-list ${entry.list === 'whitelist' ? 'pill-white active' : 'pill-white'}" data-index="${i}" data-field="list" data-val="whitelist">allow</button>
        <button class="pill pill-list ${entry.list === 'blacklist' ? 'pill-black active' : 'pill-black'}" data-index="${i}" data-field="list" data-val="blacklist">block</button>
      </div>
      <div class="match-pills">
        <button class="pill pill-type ${entry.matchType === 'domain' ? 'active' : ''}" data-index="${i}" data-field="type" data-val="domain">domain</button>
        <button class="pill pill-type ${entry.matchType === 'regex' ? 'active' : ''}" data-index="${i}" data-field="type" data-val="regex">regex</button>
      </div>
      <input type="text" value="${entry.value}" data-index="${i}" class="row-value" placeholder="${entry.matchType === 'domain' ? 'example.com' : '.*\\.example\\.com'}">
      <button class="btn-remove-row" data-index="${i}">×</button>
    </div>
  `).join("");

  container.querySelectorAll(".pill-list").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.index);
      matchState[i].list = btn.dataset.val;
      renderMatchTable();
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => saveCurrentRule(), 1000);
    });
  });

  container.querySelectorAll(".pill-type").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.index);
      matchState[i].matchType = btn.dataset.val;
      renderMatchTable();
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => saveCurrentRule(), 1000);
    });
  });

  container.querySelectorAll(".row-value").forEach(inp => {
    inp.addEventListener("input", () => {
      matchState[inp.dataset.index].value = inp.value;
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => saveCurrentRule(), 1000);
    });
  });

  container.querySelectorAll(".btn-remove-row").forEach(btn => {
    btn.addEventListener("click", () => {
      matchState.splice(Number(btn.dataset.index), 1);
      renderMatchTable();
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => saveCurrentRule(), 1000);
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

  ruleList.innerHTML = rules.map(rule => `
    <div class="rule-item ${rule.id === currentRuleId ? "active" : ""}" data-id="${rule.id}">
      <div class="rule-item-header">
        <span class="rule-status-dot ${rule.enabled ? "enabled" : ""}" data-id="${rule.id}"></span>
        <span class="rule-item-name">${rule.name || "Untitled"}</span>
        <button class="rule-delete-btn" data-id="${rule.id}">×</button>
      </div>
    </div>
  `).join("") + `<button id="newRuleBtn" class="btn-primary btn-new-rule">+ New Rule</button>`;

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
      if (rule) {
        rule.enabled = !rule.enabled;
        await saveRules(rules);
        renderRuleList();
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

      if (isEmpty || confirm("Delete this rule?")) {
        rules = await deleteRule(btn.dataset.id);
        if (currentRuleId === btn.dataset.id) {
          currentRuleId = null;
          document.getElementById("editorPanel").style.display = "none";
        }
        renderRuleList();
      }
    });
  });

  document.getElementById("newRuleBtn").addEventListener("click", createNewRule);
}

// ── Load/Save/Delete ────────────────────────────────────────
function loadRule(id) {
  const rule = rules.find(r => r.id === id);
  if (!rule) return;

  currentRuleId = id;
  const nameInput = document.getElementById("ruleName");
  nameInput.value = rule.name || "";
  nameInput.oninput = () => {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => saveCurrentRule(), 400);
  };

  matchState.length = 0;
  if (rule.whitelist) {
    rule.whitelist.forEach(entry => matchState.push({ list: "whitelist", ...entry }));
  }
  if (rule.blacklist) {
    rule.blacklist.forEach(entry => matchState.push({ list: "blacklist", ...entry }));
  }
  renderMatchTable();

  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: rule.css || "" }
  });

  // Save initial state
  initialRuleState = {
    name: rule.name || "",
    matches: JSON.stringify(matchState),
    css: rule.css || ""
  };

  document.getElementById("editorPanel").style.display = "flex";
  renderRuleList();
}

async function saveCurrentRule() {
  if (!currentRuleId) return;
  const rule = rules.find(r => r.id === currentRuleId);
  if (!rule) return;

  const currentState = {
    name: document.getElementById("ruleName").value,
    matches: JSON.stringify(matchState),
    css: editorView.state.doc.toString()
  };

  // Check if changed
  const hasChanged = !initialRuleState ||
    currentState.name !== initialRuleState.name ||
    currentState.matches !== initialRuleState.matches ||
    currentState.css !== initialRuleState.css;

  if (!hasChanged) return;

  rule.name = currentState.name;
  rule.whitelist = matchState.filter(m => m.list === "whitelist").map(({ matchType, value }) => ({ matchType, value }));
  rule.blacklist = matchState.filter(m => m.list === "blacklist").map(({ matchType, value }) => ({ matchType, value }));
  rule.css = currentState.css;

  await saveRules(rules);
  renderRuleList();

  // Update initial state
  initialRuleState = { ...currentState };

  // Show toast
  const toast = document.getElementById("saveToast");
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1500);
}

async function _deleteCurrentRule() {
  if (!currentRuleId) return;
  if (!confirm("Delete this rule?")) return;

  rules = await deleteRule(currentRuleId);
  currentRuleId = null;
  matchState.length = 0;
  document.getElementById("editorPanel").style.display = "none";
  renderRuleList();
}

function createNewRule() {
  const newRule = {
    id: crypto.randomUUID(),
    name: "New Rule",
    enabled: true,
    whitelist: [],
    blacklist: [],
    css: "/* Add your CSS here */\n",
  };
  rules.push(newRule);
  saveRules(rules);
  loadRule(newRule.id);
}

// ── Export/Import ───────────────────────────────────────────
function exportRules() {
  const blob = new Blob([JSON.stringify(rules, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "chai-rules.json";
  a.click();
  URL.revokeObjectURL(url);
}

function importFromFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await mergeImportedRules(JSON.parse(await file.text()));
    } catch (err) {
      alert("Invalid JSON file: " + err.message);
    }
  };
  input.click();
}

async function importFromUrl() {
  const url = prompt("Enter URL to import (e.g. GitHub Gist raw URL):");
  if (!url) return;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await mergeImportedRules(await res.json());
  } catch (err) {
    alert("Failed to import from URL: " + err.message);
  }
}

async function mergeImportedRules(imported) {
  if (!Array.isArray(imported)) {
    alert("Invalid format: expected a JSON array of rules.");
    return;
  }
  const newRules = imported.map(r => ({
    id: crypto.randomUUID(),
    name: r.name || "Imported Rule",
    enabled: r.enabled !== false,
    whitelist: Array.isArray(r.whitelist) ? r.whitelist : [],
    blacklist: Array.isArray(r.blacklist) ? r.blacklist : [],
    css: r.css || "",
  }));
  rules = [...rules, ...newRules];
  await saveRules(rules);
  renderRuleList();
  alert(`Imported ${newRules.length} rule(s).`);
}

// ── Init ────────────────────────────────────────────────────
async function init() {
  initEditor();
  setupMatchTable();

  rules = await getRules();
  renderRuleList();

  document.getElementById("exportBtn").addEventListener("click", exportRules);
  document.getElementById("importBtn").addEventListener("click", importFromFile);
  document.getElementById("importUrlBtn").addEventListener("click", importFromUrl);

  if (rules.length > 0) loadRule(rules[0].id);
}

init();
