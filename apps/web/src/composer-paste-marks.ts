import type { EditorState, Transaction } from "@tiptap/pm/state";

/** Continue after pasted formatting with the text on the right, or plain at a line end. */
export function setTypingMarksAfterPaste(state: EditorState): Transaction | null {
  if (!state.selection.empty) return null;
  return state.tr.setStoredMarks(state.selection.$from.nodeAfter?.marks ?? []);
}
