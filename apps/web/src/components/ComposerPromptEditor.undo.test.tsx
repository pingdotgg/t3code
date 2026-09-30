// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { act, createRef, useImperativeHandle, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { editableOwnsUndo } from "../lib/editableFocus";
import { formatInlineContextReference } from "../lib/composerContextReferences";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

let root: Root;
let container: HTMLDivElement;
const controls = createRef<{ setDraft: (value: string, thread?: string) => void }>();
function setDraft(value: string, thread?: string) {
  if (!controls.current) throw new Error("Controlled composer missing");
  controls.current.setDraft(value, thread);
}
const editorRef = createRef<ComposerPromptEditorHandle>();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function ControlledComposer() {
  const [draft, updateDraft] = useState({ value: "", thread: "a" });
  useImperativeHandle(
    controls,
    () => ({
      setDraft: (value, thread) =>
        updateDraft((current) => ({ value, thread: thread ?? current.thread })),
    }),
    [],
  );
  return (
    <ComposerPromptEditor
      historyScopeKey={draft.thread}
      value={draft.value}
      cursor={draft.value.length}
      contextRecords={new Map()}
      skills={[]}
      disabled={false}
      placeholder="Prompt"
      onChange={(value) => updateDraft((current) => ({ ...current, value }))}
      onPaste={() => {}}
      editorRef={editorRef}
    />
  );
}

function editor() {
  const element = container.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  if (!element) throw new Error("Composer editor missing");
  // Tiptap attaches the live instance to its editable DOM element.
  return (element as HTMLElement & { editor: Editor }).editor;
}

async function mount() {
  await act(async () => root.render(<ControlledComposer />));
  // jsdom has no layout; keep focus/selection real without measuring its caret.
  editor().setOptions({
    editorProps: { ...editor().options.editorProps, handleScrollToSelection: () => true },
  });
}

async function edit(run: (editor: Editor) => void) {
  await act(async () => run(editor()));
}

function ownsUndo() {
  return editableOwnsUndo(editor().view.dom);
}

describe("controlled composer undo ownership", () => {
  it("lets the empty composer yield after sending, without restoring sent text", async () => {
    await mount();
    await edit((current) => current.commands.insertContent("sent prompt"));
    await edit((current) => current.view.dispatch(closeHistory(current.state.tr)));
    await act(async () => setDraft(""));
    expect(editorRef.current?.readSnapshot().value).toBe("");
    expect(ownsUndo()).toBe(false);
    expect(editor().commands.undo()).toBe(false);
    expect(editorRef.current?.readSnapshot().value).toBe("");
  });

  it("resets an already empty editor when an attachment-only send clears the draft", async () => {
    await mount();
    await edit((current) => current.commands.insertContent("deleted draft"));
    await edit((current) => current.view.dispatch(closeHistory(current.state.tr)));
    await edit((current) => current.commands.selectAll());
    await edit((current) => current.commands.deleteSelection());
    expect(ownsUndo()).toBe(true);
    // ChatComposer.resetCursorState uses this when send clears an already
    // empty prompt, which causes no controlled value change.
    await act(async () => {
      setDraft("");
      editorRef.current?.resetUndoHistory();
    });
    expect(ownsUndo()).toBe(false);
    expect(editor().commands.undo()).toBe(false);
    expect(editorRef.current?.readSnapshot().value).toBe("");
  });

  it("preserves user deletion and yields after undo history is exhausted", async () => {
    await mount();
    await edit((current) => current.commands.insertContent("draft"));
    await edit((current) => current.view.dispatch(closeHistory(current.state.tr)));
    await edit((current) => current.commands.selectAll());
    await edit((current) => current.commands.deleteSelection());
    expect(editorRef.current?.readSnapshot().value).toBe("");
    expect(ownsUndo()).toBe(true);
    await edit((current) => current.commands.undo());
    expect(editorRef.current?.readSnapshot().value).toBe("draft");
    await edit((current) => current.commands.undo());
    expect(editorRef.current?.readSnapshot().value).toBe("");
    expect(ownsUndo()).toBe(false);
  });

  it("keeps a new thread's draft separate from the old thread's history", async () => {
    await mount();
    await edit((current) => current.commands.insertContent("thread a draft"));
    await act(async () => setDraft("thread b draft", "b"));
    await edit((current) => current.view.dispatch(closeHistory(current.state.tr)));
    await edit((current) => current.commands.selectAll());
    await edit((current) => current.commands.deleteSelection());
    expect(ownsUndo()).toBe(true);
    await edit((current) => current.commands.undo());
    expect(editorRef.current?.readSnapshot().value).toBe("thread b draft");
    expect(editor().commands.undo()).toBe(false);
    await act(async () => setDraft("", "a"));
    expect(ownsUndo()).toBe(false);
    expect(editor().commands.undo()).toBe(false);
    expect(editorRef.current?.readSnapshot().value).toBe("");
  });

  it("restores a chip-only draft after its editor deletion", async () => {
    await mount();
    const chip = formatInlineContextReference({
      kind: "file",
      contextId: "file_one",
      label: "one.ts",
    });
    await act(async () => setDraft(chip));
    expect(editorRef.current?.readSnapshot().contextIds).toEqual(["file_one"]);
    await edit((current) => current.view.dispatch(closeHistory(current.state.tr)));
    await edit((current) => current.commands.selectAll());
    await edit((current) => current.commands.deleteSelection());
    expect(editorRef.current?.readSnapshot().value).toBe("");
    expect(ownsUndo()).toBe(true);
    await edit((current) => current.commands.undo());
    expect(editorRef.current?.readSnapshot().contextIds).toEqual(["file_one"]);
  });

  it.each(["same draft", ""])(
    "keeps composer focus while isolating equal-text thread scopes (%j)",
    async (value) => {
      await mount();
      await edit((current) => current.commands.insertContent("same draft"));
      if (value === "") {
        await edit((current) => current.commands.selectAll());
        await edit((current) => current.commands.deleteSelection());
      }
      const focusedEditor = editor().view.dom;
      await act(async () => focusedEditor.focus());
      expect(document.activeElement).toBe(focusedEditor);
      await act(async () => setDraft(value, "b"));
      expect(document.activeElement).toBe(focusedEditor);
      expect(editorRef.current?.readSnapshot().value).toBe(value);
      expect(editor().commands.undo()).toBe(false);
    },
  );

  it("keeps the composer's undo grouping delay after a history reset", async () => {
    await mount();
    await edit((current) => current.commands.insertContent("sent prompt"));
    await act(async () => setDraft(""));
    // 700ms apart: one step at the composer's delay, two at ProseMirror's default.
    await edit((current) => current.view.dispatch(current.state.tr.insertText("a").setTime(1_000)));
    await edit((current) => current.view.dispatch(current.state.tr.insertText("b").setTime(1_700)));
    expect(editorRef.current?.readSnapshot().value).toBe("ab");
    await edit((current) => current.commands.undo());
    expect(editorRef.current?.readSnapshot().value).toBe("");
  });

  it("keeps new user history undoable after a send-clear", async () => {
    await mount();
    await edit((current) => current.commands.insertContent("sent prompt"));
    await act(async () => setDraft(""));
    await edit((current) => current.commands.insertContent("new draft"));
    await edit((current) => current.view.dispatch(closeHistory(current.state.tr)));
    await edit((current) => current.commands.selectAll());
    await edit((current) => current.commands.deleteSelection());
    expect(ownsUndo()).toBe(true);
    await edit((current) => current.commands.undo());
    expect(editorRef.current?.readSnapshot().value).toBe("new draft");
    await edit((current) => current.commands.undo());
    expect(editorRef.current?.readSnapshot().value).toBe("");
    expect(ownsUndo()).toBe(false);
    expect(editor().commands.undo()).toBe(false);
  });
});
