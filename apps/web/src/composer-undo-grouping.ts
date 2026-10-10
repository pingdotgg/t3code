import { closeHistory, isHistoryTransaction } from "@tiptap/pm/history";
import type { Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";

/**
 * Undo grouping matching the Lexical composer it replaced.
 *
 * ProseMirror's history only starts a new undo step after a pause or when an
 * edit is not next to the last one, so typing, backspacing and typing again
 * without pausing is one step, and a store rewrite of the whole document
 * (autocomplete inserting a chip, list continuation) makes every later edit
 * "adjacent" and joins it. Lexical instead started a new step whenever the
 * kind of change switched, and after one second without changes.
 */
export const COMPOSER_UNDO_GROUP_DELAY = 1000;

export type ComposerChangeKind = "insert" | "delete" | "other";

/**
 * Tags a transaction as a paste or cut, so it becomes its own undo step.
 * ProseMirror tags these itself only on its built-in clipboard paths; the
 * composer's `handlePaste` and cut handler replace those paths, so each of
 * their dispatches must call this, or the change merges with the typing or
 * deleting around it.
 */
export function markAsClipboardEdit(tr: Transaction, event: "paste" | "cut"): Transaction {
  return tr.setMeta("uiEvent", event);
}

function changeKindOf(tr: Transaction): ComposerChangeKind | null {
  if (!tr.docChanged) return null;
  const uiEvent = tr.getMeta("uiEvent");
  if (uiEvent === "paste" || uiEvent === "drop" || uiEvent === "cut") return "other";
  // IME input replaces its own range on each keystroke; it is still typing.
  if (tr.getMeta("composition") != null) return "insert";
  let kind: ComposerChangeKind | null = null;
  for (const step of tr.steps) {
    if (!(step instanceof ReplaceStep)) return "other";
    const inserts = step.slice.size > 0;
    const deletes = step.to > step.from;
    const stepKind = inserts && !deletes ? "insert" : deletes && !inserts ? "delete" : "other";
    if (kind !== null && kind !== stepKind) return "other";
    kind = stepKind;
  }
  return kind;
}

/**
 * Closes the current undo step before `tr` when its kind of change differs
 * from the last one, or when it is a one-off change such as a paste or a
 * store rewrite, and returns the kind to remember for the next transaction.
 * Undo and redo themselves count as one-off, so typing after them starts a
 * fresh step. Must run before the transaction is applied.
 */
export function groupUndoByChangeKind(
  tr: Transaction,
  previous: ComposerChangeKind | null,
): ComposerChangeKind | null {
  if (isHistoryTransaction(tr)) return "other";
  const kind = changeKindOf(tr);
  if (kind === null) return previous;
  if (previous !== null && (kind !== previous || kind === "other")) closeHistory(tr);
  return kind;
}
