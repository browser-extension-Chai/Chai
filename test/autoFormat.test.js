import test from "node:test";
import assert from "node:assert/strict";

import { EditorState } from "@codemirror/state";
import { history, undo, undoDepth } from "@codemirror/commands";

import { autoFormatView } from "../src/options/autoFormat.js";

/**
 * The smallest stand-in for an EditorView: it applies real transactions to a
 * real EditorState. CodeMirror's state layer needs no DOM, so the save-path
 * formatting can be exercised for real under plain Node.
 */
function createView(doc, anchor = 0, extensions = []) {
  const view = {
    state: EditorState.create({ doc, selection: { anchor }, extensions }),
    dispatched: [],
  };
  // Undo calls dispatch detached from the view, so bind it through a closure
  // rather than `this`, exactly as a real EditorView would tolerate.
  view.dispatch = (spec) => {
    const tr = view.state.update(spec);
    view.dispatched.push(tr);
    view.state = tr.state;
  };
  return view;
}

test("autoFormatView reindents the buffer and reports the rewrite", () => {
  const view = createView(".a{color:red;}");
  assert.equal(autoFormatView(view), true);
  assert.equal(view.state.doc.toString(), ".a {\n  color: red;\n}\n");
});

test("autoFormatView leaves tidy CSS and its dispatch count untouched", () => {
  const css = ".a {\n  color: red;\n}\n";
  const view = createView(css);
  assert.equal(autoFormatView(view), false);
  assert.equal(view.state.doc.toString(), css);
  assert.equal(view.dispatched.length, 0);
});

test("autoFormatView skips half-typed CSS", () => {
  for (const doc of [".a { color: url(", '.a { content: "abc; }', ".a { color: red;"]) {
    const view = createView(doc, doc.length);
    assert.equal(autoFormatView(view), false, `expected no format for ${JSON.stringify(doc)}`);
    assert.equal(view.state.doc.toString(), doc);
    assert.equal(view.dispatched.length, 0);
  }
});

test("autoFormatView keeps the reindent undoable, without dropping earlier edits", () => {
  const view = createView(".a{color:red}", 12, [history()]);

  // The user types the missing semicolon, then a save reindents the buffer.
  view.dispatch({ changes: { from: 12, insert: ";" } });
  assert.equal(undoDepth(view.state), 1);
  assert.equal(autoFormatView(view), true);
  assert.equal(view.state.doc.toString(), ".a {\n  color: red;\n}\n");

  // Ctrl-Z gives back exactly what the user had typed...
  assert.equal(undo(view), true);
  assert.equal(view.state.doc.toString(), ".a{color:red;}");

  // ...and their earlier edit is still on the stack, not swallowed by the
  // whole-document replacement.
  assert.equal(undo(view), true);
  assert.equal(view.state.doc.toString(), ".a{color:red}");
});

test("autoFormatView keeps the caret on the character it was on", () => {
  const minified = ".a{color:red}\n.b{margin:0}";
  const caret = minified.indexOf("margin") + 3; // just after "mar"
  const view = createView(minified, caret);

  assert.equal(autoFormatView(view), true);

  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  assert.equal(line.text, "  margin: 0");
  assert.equal(line.text.slice(0, head - line.from), "  mar");
});

test("autoFormatView maps a caret at the end of a minified rule onto the closing brace", () => {
  const minified = ".a{color:red;}";
  const view = createView(minified, minified.length);
  assert.equal(autoFormatView(view), true);

  const head = view.state.selection.main.head;
  assert.equal(view.state.doc.toString(), ".a {\n  color: red;\n}\n");
  // The caret followed the character it was on: the final `}` of the rule.
  assert.equal(view.state.doc.sliceString(0, head).endsWith("}"), true);
  assert.ok(head <= view.state.doc.length);
});

test("autoFormatView lands a caret at the very start before the first token", () => {
  const view = createView("  .a{color:red;}", 0);
  autoFormatView(view);
  assert.equal(view.state.selection.main.head, 0);
});

test("autoFormatView keeps the caret when nothing moved before it", () => {
  const view = createView("/* c */\n.a{color:red;}", 7);
  autoFormatView(view);
  assert.equal(view.state.doc.toString(), "/* c */\n.a {\n  color: red;\n}\n");
  assert.equal(view.state.doc.sliceString(0, view.state.selection.main.head), "/* c */");
});
