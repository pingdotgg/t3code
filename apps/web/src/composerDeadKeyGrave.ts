import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";

/** Grave-like characters dead keys emit instead of ASCII backtick (U+0060). */
export const DEAD_KEY_GRAVE_LOOKALIKES = new Set(["\u02CB", "\u2035", "\uFF40"]);

export const DEAD_KEY_GRAVE_MAX_AGE_MS = 1000;

const deadKeyStateKey = new PluginKey<{ at: number | null }>("composerDeadKeyGrave");
const appliedMetaKey = new PluginKey<undefined>("composerDeadKeyGraveApplied");

export function rememberPlainDeadKey(
  view: { dispatch: (transaction: Transaction) => void; state: EditorState },
  nowMs = performance.now(),
): void {
  view.dispatch(view.state.tr.setMeta(deadKeyStateKey, nowMs));
}

export function createComposerDeadKeyGravePlugin(): Plugin {
  return new Plugin({
    key: deadKeyStateKey,
    state: {
      init: (): { at: number | null } => ({ at: null }),
      apply(transaction, value) {
        const marked = transaction.getMeta(deadKeyStateKey);
        if (typeof marked === "number") return { at: marked };
        // The first document change spends the key. appendTransaction still
        // sees the timestamp on oldState for that same change.
        if (transaction.docChanged || transaction.getMeta(appliedMetaKey)) return { at: null };
        return value;
      },
    },
    appendTransaction(transactions, oldState, newState) {
      const deadKeyDownAt = deadKeyStateKey.getState(oldState)?.at ?? null;
      if (deadKeyDownAt == null) return null;
      if (transactions.some((transaction) => transaction.getMeta(appliedMetaKey))) return null;
      if (!transactions.some((transaction) => transaction.docChanged)) return null;
      const age = performance.now() - deadKeyDownAt;
      if (age < 0 || age > DEAD_KEY_GRAVE_MAX_AGE_MS) return null;
      if (
        transactions.some(
          (transaction) =>
            transaction.getMeta("paste") === true || transaction.getMeta("uiEvent") === "paste",
        )
      ) {
        return null;
      }

      const steps = transactions.flatMap((transaction) =>
        transaction.steps.filter((step): step is ReplaceStep => step instanceof ReplaceStep),
      );
      const step = steps.length === 1 ? steps[0] : null;
      if (!step || !sameTextblock(oldState.doc, step.from, step.to)) return null;
      const inserted = insertedInlineText(step);
      if (inserted == null) return null;
      const deleted = oldState.doc.textBetween(step.from, step.to);
      const edit = deadKeyGraveTextEdit(deleted, inserted);
      if (!edit) return null;

      const lookalikeAt = step.from + edit.index;
      if (newState.doc.textBetween(lookalikeAt, lookalikeAt + 1) !== inserted[edit.index]) {
        return null;
      }
      const replacement = edit.deleted.length === 0 ? "`" : `\`${edit.deleted}\``;
      return newState.tr
        .insertText(replacement, lookalikeAt, lookalikeAt + 1)
        .setMeta(appliedMetaKey, true);
    },
  });
}

export function isPlainDeadKeyDown(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "isComposing">,
): boolean {
  return event.key === "Dead" && !event.metaKey && !event.ctrlKey && !event.isComposing;
}

export function deadKeyGraveTextEdit(
  before: string,
  after: string,
): { index: number; deleted: string } | null {
  if (before === after) return null;
  let start = 0;
  const maxStart = Math.min(before.length, after.length);
  while (start < maxStart && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const inserted = after.slice(start, endAfter);
  if (inserted.length !== 1 || !DEAD_KEY_GRAVE_LOOKALIKES.has(inserted)) return null;
  return { index: start, deleted: before.slice(start, endBefore) };
}

function insertedInlineText(step: ReplaceStep): string | null {
  let text = "";
  let inline = true;
  step.slice.content.forEach((node) => {
    if (!inline) return;
    if (!node.isText || node.text == null) {
      inline = false;
      return;
    }
    text += node.text;
  });
  return inline ? text : null;
}

function sameTextblock(doc: ProseMirrorNode, from: number, to: number): boolean {
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  return $from.sameParent($to) && $from.parent.isTextblock;
}
