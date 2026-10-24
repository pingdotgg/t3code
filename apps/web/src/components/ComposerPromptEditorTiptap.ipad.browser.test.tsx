import type { Editor } from "@tiptap/core";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { createRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";

import { composerSubmissionIntentForKey } from "~/composer-logic";
import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

vi.hoisted(() => {
  Object.defineProperty(navigator, "vendor", { configurable: true, value: "Apple Computer, Inc." });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
});

async function mountEditor(richTextEnabled: boolean) {
  const send = vi.fn();
  const screen = await render(
    <ComposerPromptEditor
      editorRef={createRef<ComposerPromptEditorHandle>()}
      value="first"
      cursor={5}
      richTextEnabled={richTextEnabled}
      contextRecords={new Map()}
      skills={[]}
      disabled={false}
      placeholder=""
      onChange={() => {}}
      onPaste={() => {}}
      onCommandKeyDown={(_, event) => {
        const intent = composerSubmissionIntentForKey({
          event,
          keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
          platform: "MacIntel",
          isSoftwareKeyboardOpen: false,
          isDraftThread: false,
          sendShortcut: "enter",
        });
        if (intent === null) return false;
        send(intent);
        return true;
      }}
    />,
  );
  const element = screen.container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) {
    await screen[Symbol.asyncDispose]();
    throw new Error("Composer did not mount");
  }
  return Object.assign(screen, { editor: element.editor, send });
}

it.each([false, true])(
  "inserts a newline instead of sending iPad Shift+Enter (rich text: %s)",
  async (richTextEnabled) => {
    await using screen = await mountEditor(richTextEnabled);
    const { editor, send } = screen;
    await act(async () => {
      editor.view.focus();
      editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 13,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(send).not.toHaveBeenCalled();
    expect(serializeEditorDoc(editor.state.doc).value).toBe("first\n");
  },
);

it("still sends an unmodified iPad Enter", async () => {
  await using screen = await mountEditor(false);
  const { editor, send } = screen;
  await act(async () => {
    editor.view.focus();
    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  expect(send).toHaveBeenCalledExactlyOnceWith("foreground");
});

it("inserts exactly one newline with native Shift+Enter input", async () => {
  await using screen = await mountEditor(false);
  const { editor, send } = screen;
  await act(() => editor.view.focus());
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(send).not.toHaveBeenCalled();
  expect(serializeEditorDoc(editor.state.doc).value).toBe("first\n");
});

it("does not lose Shift+Enter when another key arrives before the iOS fallback", async () => {
  await using screen = await mountEditor(false);
  const { editor, send } = screen;
  await act(async () => {
    editor.view.focus();
    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 13,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", keyCode: 37, bubbles: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  expect(send).not.toHaveBeenCalled();
  expect(serializeEditorDoc(editor.state.doc).value).toBe("first\n");
});

it("does not edit a read-only composer on Shift+Enter", async () => {
  await using screen = await mountEditor(false);
  const { editor, send } = screen;
  await act(async () => {
    editor.view.focus();
    editor.setEditable(false);
    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 13,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  expect(send).not.toHaveBeenCalled();
  expect(serializeEditorDoc(editor.state.doc).value).toBe("first");
});

it.each([false, true])(
  "does not insert a newline when confirming composition (composition ended: %s)",
  async (compositionEnded) => {
    await using screen = await mountEditor(false);
    const { editor, send } = screen;
    await act(async () => {
      editor.view.focus();
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
      if (compositionEnded) {
        editor.view.dom.dispatchEvent(new CompositionEvent("compositionend"));
      }
      editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 13,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(send).not.toHaveBeenCalled();
    expect(serializeEditorDoc(editor.state.doc).value).toBe("first");
  },
);
