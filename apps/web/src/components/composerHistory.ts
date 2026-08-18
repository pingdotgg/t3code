import type { HistoryState } from "@lexical/react/LexicalHistoryPlugin";
import {
  $getRoot,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  type EditorState,
  type LexicalEditor,
} from "lexical";

/** Captures the editor state that a controlled value change will undo to. */
export function captureComposerHistoryEntry(options: {
  editor: LexicalEditor;
  historyState: HistoryState;
  nextValue: string;
}): EditorState {
  const { editor, historyState, nextValue } = options;
  const editorState = editor.getEditorState();
  historyState.current = { editor, editorState };

  const valueWillChange = editorState.read(() => $getRoot().getTextContent() !== nextValue);
  if (valueWillChange) return editorState;

  // Side state such as image attachments can change while Lexical's value
  // stays the same. Give that action its own undo entry. The clone must be a
  // different object so a later text edit does not match this entry early.
  const undoEditorState = editorState.clone();
  if (historyState.redoStack.length > 0) {
    historyState.redoStack.length = 0;
    editor.dispatchCommand(CAN_REDO_COMMAND, false);
  }
  historyState.undoStack.push({ editor, editorState: undoEditorState });
  editor.dispatchCommand(CAN_UNDO_COMMAND, true);
  return undoEditorState;
}
