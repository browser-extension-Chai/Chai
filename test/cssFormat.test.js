import test from "node:test";
import assert from "node:assert/strict";

import { formatCss, isBalancedCss } from "../src/shared/cssFormat.js";

test("formatCss expands a minified rule", () => {
  assert.equal(
    formatCss(".a{color:red;background:blue}"),
    ".a {\n  color: red;\n  background: blue\n}\n",
  );
});

test("formatCss is a no-op on already tidy CSS", () => {
  const css = "/* Header */\n.a {\n  color: red;\n}\n\n.b {\n  color: blue;\n}\n";
  assert.equal(formatCss(css), css);
});

test("formatCss adds a blank line between rules and drops runs of blank lines", () => {
  assert.equal(
    formatCss(".a {\n  color: red;\n}\n\n\n\n.b {\n  color: blue;\n}\n\n\n"),
    ".a {\n  color: red;\n}\n\n.b {\n  color: blue;\n}\n",
  );
});

test("formatCss indents nested blocks without a blank line before the closing brace", () => {
  assert.equal(
    formatCss("@media (min-width: 600px) { .a { color: red; } }"),
    "@media (min-width: 600px) {\n  .a {\n    color: red;\n  }\n}\n",
  );
});

test("formatCss keeps a trailing declaration's missing semicolon missing", () => {
  assert.equal(formatCss(".a { color: red }"), ".a {\n  color: red\n}\n");
});

test("formatCss spaces a declaration colon but leaves selectors alone", () => {
  assert.equal(formatCss("a:hover{color:red;}"), "a:hover {\n  color: red;\n}\n");
  assert.equal(formatCss(":root{--x:1;}"), ":root {\n  --x: 1;\n}\n");
});

test("formatCss preserves semicolons and braces inside strings", () => {
  assert.equal(
    formatCss('.a{content:"a;b}";content:\'{"\'}'),
    '.a {\n  content: "a;b}";\n  content: \'{"\'\n}\n',
  );
});

test("formatCss preserves data URIs, including their semicolons and colons", () => {
  const css = '.a {\n  background: url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=);\n}\n';
  assert.equal(formatCss(css), css);
  assert.equal(
    formatCss('.a{background:url("data:image/png;base64,AA==") no-repeat}'),
    '.a {\n  background: url("data:image/png;base64,AA==") no-repeat\n}\n',
  );
});

test("formatCss leaves at-rules and their URLs untouched", () => {
  const css = '@namespace svg url(http://www.w3.org/2000/svg);\n@import url("a.css") screen and (min-width:600px);\n';
  assert.equal(formatCss(css), css);
});

test("formatCss normalises whitespace inside a selector and a value", () => {
  assert.equal(
    formatCss(".a,\n.b   >   .c {\n  margin:  calc(100%   -  10px) ;\n}\n"),
    ".a, .b > .c {\n  margin: calc(100% - 10px);\n}\n",
  );
});

test("formatCss keeps adjacent strings apart", () => {
  assert.equal(
    formatCss('.a{grid-template-areas:"head head"   "nav main"}'),
    '.a {\n  grid-template-areas: "head head" "nav main"\n}\n',
  );
});

test("formatCss puts a leading comment on its own line and keeps a trailing one inline", () => {
  assert.equal(
    formatCss("/* Header */.a{color:red;/* note */background:blue}"),
    "/* Header */\n.a {\n  color: red; /* note */\n  background: blue\n}\n",
  );
  assert.equal(
    formatCss(".a {\n  /* own line */\n  color: red;\n}\n"),
    ".a {\n  /* own line */\n  color: red;\n}\n",
  );
});

test("formatCss preserves a multi-line comment's body", () => {
  assert.equal(
    formatCss(".a{/* first\n * second\n */color:red;}"),
    ".a {\n  /* first\n   * second\n   */\n  color: red;\n}\n",
  );
});

test("formatCss keeps a closed declaration before a comment", () => {
  assert.equal(
    formatCss(".a{color:red;/* trailing */}"),
    ".a {\n  color: red; /* trailing */\n}\n",
  );
});

test("formatCss handles an empty document and a bare declaration fragment", () => {
  assert.equal(formatCss(""), "");
  assert.equal(formatCss("\n\n"), "");
  assert.equal(formatCss("color:red;"), "color: red;\n");
});

test("formatCss is idempotent on its own output", () => {
  const samples = [
    ".a{color:red;background:url(data:image/png;base64,AA==)}",
    "@media (min-width:600px){.a{color:red}.b{color:blue}}",
    '/* c */.a{content:";"}@keyframes spin{from{opacity:0}to{opacity:1}}',
    ".a,\n.b{color:red}",
    "/* only a comment */",
  ];
  for (const sample of samples) {
    const once = formatCss(sample);
    assert.equal(formatCss(once), once, `not idempotent: ${JSON.stringify(sample)}`);
  }
});

test("isBalancedCss accepts complete CSS and rejects half-typed CSS", () => {
  assert.equal(isBalancedCss(".a { color: red; }"), true);
  assert.equal(isBalancedCss("@media (min-width: 600px) { .a { color: red; } }"), true);
  assert.equal(isBalancedCss('/* } */ .a { content: "}"; }'), true);
  assert.equal(isBalancedCss(""), true);

  assert.equal(isBalancedCss(".a { color: red;"), false);
  assert.equal(isBalancedCss("}"), false);
  assert.equal(isBalancedCss(".a { color: url("), false);
  assert.equal(isBalancedCss('.a { content: "abc; }'), false);
  assert.equal(isBalancedCss(".a { /* open"), false);
  assert.equal(isBalancedCss(undefined), false);
});
