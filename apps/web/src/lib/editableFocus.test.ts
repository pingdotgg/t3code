// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { closeHistory, undoDepth } from "@tiptap/pm/history";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { editableOwnsUndo, registerEditableUndoHistory } from "./editableFocus";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function composer() {
  const editor = new Editor({ extensions: [StarterKit], content: "" });
  cleanups.push(() => editor.destroy());
  cleanups.push(registerEditableUndoHistory(editor.view.dom, () => undoDepth(editor.state) > 0));
  return editor;
}

describe("editableOwnsUndo", () => {
  it("lets an untouched empty composer yield, while preserving a draft", () => {
    const editor = composer();
    expect(editableOwnsUndo(editor.view.dom)).toBe(false);
    editor.commands.insertContent("draft");
    expect(editableOwnsUndo(editor.view.dom)).toBe(true);
  });

  it("preserves deleted text even when deletion precedes a thread notice", () => {
    const editor = composer();
    editor.commands.insertContent("draft");
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.commands.clearContent();
    // Programmatic editor transactions emit no DOM input event. Thread notices
    // must not reset ownership of the editor's existing undo stack.
    expect(editor.view.dom.textContent).toBe("");
    expect(editableOwnsUndo(editor.view.dom)).toBe(true);
    editor.commands.undo();
    expect(editor.getText()).toBe("draft");
  });

  it("yields again after the editor exhausts its undo stack", () => {
    const editor = composer();
    editor.commands.insertContent("draft");
    editor.commands.undo();
    expect(editor.getText()).toBe("");
    expect(editableOwnsUndo(editor.view.dom)).toBe(false);
  });

  it("keeps independent editor histories and releases unmounted editors", () => {
    const edited = composer();
    const untouched = composer();
    edited.commands.insertContent("draft");
    edited.commands.clearContent();
    expect(editableOwnsUndo(edited.view.dom)).toBe(true);
    expect(editableOwnsUndo(untouched.view.dom)).toBe(false);
    const release = registerEditableUndoHistory(untouched.view.dom, () => false);
    release();
    expect(editableOwnsUndo(untouched.view.dom)).toBe(true);
  });

  it("preserves native input history and ignores non-editable targets", () => {
    expect(editableOwnsUndo(document.createElement("input"))).toBe(true);
    expect(editableOwnsUndo(document.createElement("textarea"))).toBe(true);
    expect(editableOwnsUndo(document.createElement("button"))).toBe(false);
    expect(editableOwnsUndo(null)).toBe(false);
  });
});
