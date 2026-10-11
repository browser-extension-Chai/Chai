/**
 * Pure CSS pretty-printer for the options editor.
 *
 * Deliberately free of DOM and `chrome.*` so it can be unit tested under plain
 * Node (see test/cssFormat.test.js).
 *
 * Normalised: one declaration per line, block indentation, a space after a
 * declaration's colon, tool-generated brace/indent layout and comment
 * placement.
 *
 * Left exactly as written: strings, comments, everything inside parentheses
 * (`url(...)`, `data:` URIs, media features), values in general, and whether a
 * trailing declaration carries its `;`. The formatter never invents or drops
 * tokens, so re-running it on its own output is a no-op.
 */

export const DEFAULT_INDENT = "  ";

/**
 * Whitespace as CSS and this formatter see it. Exported because callers that
 * map offsets between the input and the formatted output must agree with the
 * tokenizer on exactly which characters can be rearranged.
 */
export function isWhitespace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/**
 * Split CSS into structural tokens: `text`, `string`, `comment`, `open`,
 * `close` and `semi`. Delimiters inside strings and comments never leak into
 * the surrounding text, which is what lets a value such as
 * `content: "a;b}"` survive formatting intact.
 */
export function tokenizeCss(raw) {
  const tokens = [];
  let text = "";
  let i = 0;
  const n = raw.length;

  const flushText = () => {
    if (text !== "") {
      tokens.push({ type: "text", value: text });
      text = "";
    }
  };

  while (i < n) {
    const ch = raw[i];

    if (ch === "/" && raw[i + 1] === "*") {
      const end = raw.indexOf("*/", i + 2);
      const value = end === -1 ? raw.slice(i) : raw.slice(i, end + 2);
      flushText();
      tokens.push({ type: "comment", value, unterminated: end === -1 });
      i += value.length;
      continue;
    }

    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const c = raw[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") break;
        j += 1;
        if (c === ch) {
          closed = true;
          break;
        }
      }
      flushText();
      tokens.push({ type: "string", value: raw.slice(i, j), unterminated: !closed });
      i = j;
      continue;
    }

    if (ch === "{" || ch === "}" || ch === ";") {
      flushText();
      tokens.push({ type: ch === "{" ? "open" : ch === "}" ? "close" : "semi", value: ch });
      i += 1;
      continue;
    }

    text += ch;
    i += 1;
  }

  flushText();
  return tokens;
}

/**
 * True when braces, parentheses and strings all close.
 *
 * Automatic formatting is skipped for anything else: half-typed CSS is
 * reindented the moment it is finished, not while it is being written.
 */
export function isBalancedCss(raw) {
  if (typeof raw !== "string") return false;

  let depth = 0;
  let parens = 0;

  for (const token of tokenizeCss(raw)) {
    if (token.unterminated) return false;

    if (token.type === "open") {
      depth += 1;
    } else if (token.type === "close") {
      depth -= 1;
      if (depth < 0) return false;
    } else if (token.type === "text") {
      for (const ch of token.value) {
        if (ch === "(") parens += 1;
        else if (ch === ")") {
          parens -= 1;
          if (parens < 0) return false;
        }
      }
    }
  }

  return depth === 0 && parens === 0;
}

/**
 * Space a declaration's colon, and nothing else.
 *
 * Only the first colon outside parentheses counts, so at-rules
 * (`@namespace svg url(http://…)`) and URLs keep their shape while
 * `color:red` becomes `color: red`.
 */
function spaceDeclarationColon(value) {
  if (value.startsWith("@")) return value;

  let parens = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "(") parens += 1;
    else if (ch === ")") parens = Math.max(0, parens - 1);
    else if (ch === ":" && parens === 0) {
      return `${value.slice(0, i).trimEnd()}: ${value.slice(i + 1).trimStart()}`;
    }
  }
  return value;
}

/**
 * Reindent CSS. Returns the input unchanged when it is already tidy, which is
 * what makes formatting on every save idempotent.
 */
export function formatCss(raw, { indent = DEFAULT_INDENT } = {}) {
  if (typeof raw !== "string") return "";
  if (raw === "") return raw;

  const lines = [];
  let depth = 0;
  let parens = 0;
  let buf = "";
  let pendingSpace = false;
  let pendingNewline = false;

  const emit = (value) => lines.push(indent.repeat(depth) + value);
  const blank = () => {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
  };
  const take = () => {
    const value = buf.trim();
    buf = "";
    pendingSpace = false;
    pendingNewline = false;
    return value;
  };
  const appendRaw = (value) => {
    if (value === "") return;
    if (buf !== "" && pendingSpace) buf += " ";
    buf += value;
    pendingSpace = false;
    pendingNewline = false;
  };
  const appendText = (value) => {
    for (const ch of value) {
      if (isWhitespace(ch)) {
        if (buf !== "") pendingSpace = true;
        if (ch === "\n") pendingNewline = true;
        continue;
      }
      if (pendingSpace && buf !== "") buf += " ";
      pendingSpace = false;
      pendingNewline = false;
      buf += ch;
    }
  };
  const emitComment = (value) => {
    const [first, ...rest] = value.split("\n");
    emit(first.trim());
    for (const line of rest) {
      const trimmed = line.trim();
      if (trimmed === "") lines.push("");
      else emit(` ${trimmed}`);
    }
  };

  for (const token of tokenizeCss(raw)) {
    if (token.type === "text") {
      for (const ch of token.value) {
        if (ch === "(") parens += 1;
        else if (ch === ")") parens = Math.max(0, parens - 1);
      }
      appendText(token.value);
    } else if (token.type === "string") {
      appendRaw(token.value);
    } else if (token.type === "comment") {
      if (token.value.includes("\n") || pendingNewline) {
        const pending = take();
        if (pending) emit(pending);
        emitComment(token.value);
      } else if (buf.trim() === "") {
        // A one-line comment with no blank space before it belongs to the line
        // it followed: `color: red; /* note */`.
        const last = lines.length - 1;
        if (last >= 0 && lines[last] !== "") lines[last] += ` ${token.value.trim()}`;
        else emitComment(token.value);
        pendingSpace = false;
        pendingNewline = false;
      } else {
        appendRaw(token.value);
      }
    } else if (token.type === "open") {
      const selector = take();
      emit(selector ? `${selector} {` : "{");
      depth += 1;
    } else if (token.type === "close") {
      // A declaration may end at `}` without a semicolon; keep it that way.
      const trailing = take();
      if (trailing) emit(depth > 0 ? spaceDeclarationColon(trailing) : trailing);
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      depth = Math.max(0, depth - 1);
      emit("}");
      blank();
    } else if (token.type === "semi") {
      // A `;` inside parentheses is part of a value (`url(data:…;base64,…)`).
      if (parens > 0) {
        appendRaw(";");
        continue;
      }
      const statement = take();
      if (statement) emit(`${spaceDeclarationColon(statement)};`);
    }
  }

  const tail = take();
  if (tail) emit(depth > 0 ? spaceDeclarationColon(tail) : tail);
  if (lines.length === 0) return "";

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
