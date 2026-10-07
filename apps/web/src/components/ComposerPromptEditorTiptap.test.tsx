// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle,
} from "./ComposerPromptEditorTiptap";

let root: Root;
let container: HTMLDivElement;

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

function ControlledComposer({
  initialValue,
  richTextEnabled,
}: {
  initialValue: string;
  richTextEnabled: boolean;
}) {
  const [draft, setDraft] = useState({ value: initialValue, cursor: initialValue.length });
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  return (
    <>
      <ComposerPromptEditorTiptap
        {...draft}
        richTextEnabled={richTextEnabled}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder="Message"
        editorRef={editorRef}
        onChange={(value, cursor) => setDraft({ value, cursor })}
        onPaste={() => {}}
      />
      <output>{draft.value}</output>
    </>
  );
}

async function renderComposer(value: string, richTextEnabled: boolean) {
  await act(async () => {
    root.render(<ControlledComposer initialValue={value} richTextEnabled={richTextEnabled} />);
  });
  const element = container.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  if (!element || !("editor" in element) || !(element.editor instanceof Editor)) {
    throw new Error("Composer editor was not mounted");
  }
  return element.editor;
}

// Replay the text replacement that ProseMirror reports after committing a dead
// key. The replacement range can cover provisional text even with an empty selection.
async function inputText(editor: Editor, from: number, to: number, text: string) {
  await act(async () => {
    const { view } = editor;
    const defaultInsert = () => view.state.tr.insertText(text, from, to);
    const handled = view.someProp("handleTextInput", (handler) =>
      handler(view, from, to, text, defaultInsert),
    );
    if (!handled) view.dispatch(defaultInsert());
  });
}

function expectDraft(editor: Editor, value: string) {
  expect(editor.getText()).toBe(value);
  expect(container.querySelector("output")?.textContent).toBe(value);
}

describe.each([false, true])("composer text input with rich text %s", (richTextEnabled) => {
  it("replaces a provisional dead-key accent with one apostrophe", async () => {
    const editor = await renderComposer("s´", richTextEnabled);
    expect(editor.state.selection.empty).toBe(true);

    await inputText(editor, 2, 3, "'");
    expectDraft(editor, "s'");

    await inputText(editor, 3, 3, "il");
    expectDraft(editor, "s'il");
  });

  it("still surrounds a deliberately selected word", async () => {
    const editor = await renderComposer("mot", richTextEnabled);
    await act(async () => {
      editor.commands.setTextSelection({ from: 1, to: 4 });
    });

    await inputText(editor, 1, 4, "'");
    expectDraft(editor, "'mot'");
    expect(
      editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to),
    ).toBe("mot");
  });

  it("inserts an ordinary apostrophe at the caret", async () => {
    const editor = await renderComposer("s", richTextEnabled);
    await inputText(editor, 2, 2, "'");
    expectDraft(editor, "s'");
  });

  it.each(["é", "ê"])("preserves an accent committed as %s", async (accent) => {
    const editor = await renderComposer("s´", richTextEnabled);
    await inputText(editor, 2, 3, accent);
    expectDraft(editor, `s${accent}`);
  });

  it("does not surround a replacement while composition is active", async () => {
    const editor = await renderComposer("s´", richTextEnabled);
    await act(async () => {
      editor.commands.setTextSelection({ from: 2, to: 3 });
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    expect(editor.view.composing).toBe(true);
    await inputText(editor, 2, 3, "'");
    expectDraft(editor, "s'");
  });
});
