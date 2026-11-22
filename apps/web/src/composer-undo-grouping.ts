import { closeHistory, isHistoryTransaction, redoDepth, undoDepth } from "@tiptap/pm/history";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";

// Whole-draft rewrites make all edits adjacent; explicit boundaries keep change kinds separate.
export const COMPOSER_UNDO_GROUP_DELAY = 1000;

export type ComposerChangeKind = "insert" | "delete" | "other";

export interface ComposerHistoryRevision {
  readonly revision: number;
  readonly activeRevisions: ReadonlyArray<number>;
  readonly direction: "undo" | "redo" | null;
}

interface ComposerHistoryRevisionState {
  readonly current: number;
  readonly nextId: number;
  readonly undo: ReadonlyArray<number>;
  readonly redo: ReadonlyArray<number>;
  readonly direction: "undo" | "redo" | null;
}

const composerHistoryRevisionPluginKey = new PluginKey<ComposerHistoryRevisionState>(
  "composerHistoryRevision",
);

/**
 * Mirrors ProseMirror's undo/redo event stacks with monotonic revision IDs so
 * external state stays accurate across controlled rewrites and history overflow trimming.
 * Register after the ProseMirror history plugin.
 */
export function createComposerHistoryRevisionPlugin(): Plugin<ComposerHistoryRevisionState> {
  return new Plugin<ComposerHistoryRevisionState>({
    key: composerHistoryRevisionPluginKey,
    state: {
      init(): ComposerHistoryRevisionState {
        return { current: 0, nextId: 1, undo: [], redo: [], direction: null };
      },
      apply(tr, prev, oldState, newState): ComposerHistoryRevisionState {
        const prevUndoDepth = Number(undoDepth(oldState));
        const prevRedoDepth = Number(redoDepth(oldState));
        const nextUndoDepth = Number(undoDepth(newState));
        const nextRedoDepth = Number(redoDepth(newState));

        if (isHistoryTransaction(tr)) {
          if (nextUndoDepth < prevUndoDepth) {
            const landed = prev.undo.at(-1) ?? prev.current;
            const nextRedo = [...prev.redo, prev.current];
            return {
              current: landed,
              nextId: prev.nextId,
              undo: prev.undo.slice(0, -1),
              redo:
                nextRedo.length > nextRedoDepth
                  ? nextRedo.slice(nextRedo.length - nextRedoDepth)
                  : nextRedo,
              direction: "undo",
            };
          }
          if (nextRedoDepth < prevRedoDepth) {
            const landed = prev.redo.at(-1) ?? prev.current;
            const nextUndo = [...prev.undo, prev.current];
            return {
              current: landed,
              nextId: prev.nextId,
              undo:
                nextUndo.length > nextUndoDepth
                  ? nextUndo.slice(nextUndo.length - nextUndoDepth)
                  : nextUndo,
              redo: prev.redo.slice(0, -1),
              direction: "redo",
            };
          }
          return { ...prev, direction: null };
        }

        const appended = tr.getMeta("appendedTransaction") as Transaction | undefined;
        if (
          tr.steps.length === 0 ||
          tr.getMeta("addToHistory") === false ||
          appended?.getMeta("addToHistory") === false ||
          (appended && isHistoryTransaction(appended))
        ) {
          return { ...prev, direction: null };
        }

        if (nextUndoDepth !== prevUndoDepth) {
          const nextUndo = [...prev.undo, prev.current];
          return {
            current: prev.nextId,
            nextId: prev.nextId + 1,
            undo:
              nextUndo.length > nextUndoDepth
                ? nextUndo.slice(nextUndo.length - nextUndoDepth)
                : nextUndo,
            redo: [],
            direction: null,
          };
        }

        return {
          current: prev.current,
          nextId: prev.nextId,
          undo: prev.undo,
          redo: [],
          direction: null,
        };
      },
    },
  });
}

export function composerHistoryRevisionOf(state: EditorState): ComposerHistoryRevision {
  const revisionState = composerHistoryRevisionPluginKey.getState(state);
  if (!revisionState) {
    return { revision: 0, activeRevisions: [0], direction: null };
  }
  return {
    revision: revisionState.current,
    activeRevisions: [...revisionState.undo, revisionState.current, ...revisionState.redo],
    direction: revisionState.direction,
  };
}

const CLIPBOARD_EDIT_META = "composerClipboardEdit";
const COMPOSITION_REPLACE_META = "composerCompositionReplace";

/**
 * Tag custom paste/cut dispatches; ProseMirror only tags its built-in paths.
 * Not `uiEvent`: Tiptap's paste rules would style the already parsed paste a second time.
 */
export function markAsClipboardEdit(tr: Transaction, event: "paste" | "cut"): Transaction {
  return tr.setMeta(CLIPBOARD_EDIT_META, event);
}

/** Start a replacement undo group, keeping the IME edits together and prior typing separate. */
export function markAsCompositionReplace(tr: Transaction): Transaction {
  return closeHistory(tr).setMeta(COMPOSITION_REPLACE_META, true);
}

function changeKindOf(tr: Transaction): ComposerChangeKind | null {
  if (!tr.docChanged) return null;
  const uiEvent = tr.getMeta("uiEvent");
  if (uiEvent === "paste" || uiEvent === "drop" || uiEvent === "cut") return "other";
  if (tr.getMeta(CLIPBOARD_EDIT_META) != null) return "other";
  // IME input replaces its own range on each keystroke; it is still typing.
  if (tr.getMeta("composition") != null || tr.getMeta(COMPOSITION_REPLACE_META)) return "insert";
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
