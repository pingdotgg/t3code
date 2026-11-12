import { closeHistory, isHistoryTransaction } from "@tiptap/pm/history";
import type { Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";

// Whole-draft rewrites make all edits adjacent; explicit boundaries keep change kinds separate.
export const COMPOSER_UNDO_GROUP_DELAY = 1000;

export type ComposerChangeKind = "insert" | "delete" | "other";

/** Tag custom paste/cut dispatches; ProseMirror only tags its built-in paths. */
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

/** Must run before the transaction is applied. */
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
