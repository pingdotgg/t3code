import { createEmptyHistoryState } from "@lexical/react/LexicalHistoryPlugin";
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import { describe, expect, it } from "vite-plus/test";

import { captureComposerHistoryEntry } from "./composerHistory";

function createEditorWithValue(value: string) {
  const editor = createEditor();
  editor.update(
    () => {
      $getRoot().append($createParagraphNode().append($createTextNode(value)));
    },
    { discrete: true },
  );
  return editor;
}

describe("captureComposerHistoryEntry", () => {
  it("adds a distinct undo entry when clearing side state leaves the value unchanged", () => {
    const editor = createEditorWithValue("");
    const historyState = createEmptyHistoryState();
    historyState.redoStack.push({ editor, editorState: editor.getEditorState() });

    const undoEditorState = captureComposerHistoryEntry({
      editor,
      historyState,
      nextValue: "",
    });

    expect(historyState.undoStack).toEqual([{ editor, editorState: undoEditorState }]);
    expect(undoEditorState).not.toBe(historyState.current?.editorState);
    expect(historyState.redoStack).toEqual([]);
    expect(undoEditorState.read(() => $getRoot().getTextContent())).toBe("");
  });

  it("lets the controlled text update create the undo entry when the value changes", () => {
    const editor = createEditorWithValue("stashed text");
    const historyState = createEmptyHistoryState();

    const editorState = captureComposerHistoryEntry({
      editor,
      historyState,
      nextValue: "",
    });

    expect(editorState).toBe(editor.getEditorState());
    expect(historyState.current?.editorState).toBe(editorState);
    expect(historyState.undoStack).toEqual([]);
  });
});
