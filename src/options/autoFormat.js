import { isolateHistory } from "@codemirror/commands";
import { formatCss, isBalancedCss, isWhitespace } from "../shared/cssFormat.js";

/** Non-whitespace characters in `text` before `index`. */
function nonSpaceCountBefore(text, index) {
  let count = 0;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (!isWhitespace(text[i])) count += 1;
  }
  return count;
}

/** Offset just after the `count`-th non-whitespace character of `text`. */
function offsetAfterNonSpace(text, count) {
  let seen = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (isWhitespace(text[i])) continue;
    if (count <= 0) return i;
    seen += 1;
    if (seen === count) return i + 1;
  }
  return text.length;
}

/**
 * Reindent a CodeMirror buffer in place.
 *
 * Called only on the save path, never from an input handler, so the caret is
 * never yanked mid-keystroke. Half-typed CSS (unbalanced braces, parentheses or
 * quotes) is left exactly as it is and tidied once it is finished.
 *
 * The rewrite is an ordinary edit as far as the undo history is concerned, the
 * way format-on-save behaves elsewhere: Ctrl-Z restores exactly the text the
 * user had typed. Marking it `addToHistory: false` is not an option — the
 * history maps pending edits through every document change, and edits swallowed
 * by a whole-document replacement are dropped, which silently empties the undo
 * stack.
 *
 * Returns true when the document was rewritten. The caller is responsible for
 * suppressing its own change listener around the synchronous dispatch.
 */
export function autoFormatView(view) {
  const doc = view.state.doc;
  const raw = doc.toString();
  if (!isBalancedCss(raw)) return false;

  const formatted = formatCss(raw);
  if (formatted === raw) return false;

  const head = view.state.selection.main.head;

  view.dispatch({
    changes: { from: 0, to: doc.length, insert: formatted },
    // Its own undo step on both sides, so a Ctrl-Z after a save always undoes
    // the reindent itself rather than being folded into the preceding typing.
    annotations: isolateHistory.of("full"),
  });

  // Replacing the whole document collapses the selection onto its end, so put
  // the caret back: formatting only rearranges whitespace, which means the
  // sequence of non-whitespace characters is identical before and after.
  // Counting them is an exact way to find the character the caret was on, even
  // when one minified line became a whole block.
  const anchor = offsetAfterNonSpace(formatted, nonSpaceCountBefore(raw, head));
  view.dispatch({ selection: { anchor } });
  return true;
}
