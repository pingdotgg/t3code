import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";

import { createComposerVimHost, Vim } from "./composer-vim-adapter";
import { ComposerVimExtension, setComposerVimHost } from "./composer-vim-editor";
import { createTextareaVimHost } from "./textarea-vim";
import reference from "./composer-vim.reference.json";

function mountComposer(text: string) {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit.configure({ undoRedo: { newGroupDelay: 1000 } }), ComposerVimExtension],
    content: {
      type: "doc",
      content: text.split("\n").map((line) => ({
        type: "paragraph",
        ...(line ? { content: [{ type: "text", text: line }] } : {}),
      })),
    },
  });
  const host = createComposerVimHost(editor.view);
  setComposerVimHost(editor.view, host);
  editor.view.focus();
  return {
    host,
    typeCharacter: (key: string) => editor.view.dispatch(editor.view.state.tr.insertText(key)),
    [Symbol.dispose]() {
      host.destroy();
      editor.destroy();
      element.remove();
    },
  };
}

function mountTextarea(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  document.body.append(textarea);
  textarea.focus();
  const host = createTextareaVimHost(textarea);
  return {
    host,
    typeCharacter(key: string) {
      host.editor.onBeforeNativeInput();
      textarea.setRangeText(key, textarea.selectionStart, textarea.selectionEnd, "end");
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    },
    [Symbol.dispose]() {
      host.destroy();
      textarea.remove();
    },
  };
}

function typeInDialog(key: string) {
  const input = document.activeElement;
  if (!(input instanceof HTMLInputElement)) return false;
  if (key === "<CR>") {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  }
  input.value += key;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
  return true;
}

// The engine differs here, and a fix would mean carrying a larger patch for small cases.
const ENGINE_DIFFERENCES = new Set([
  // Vim also takes the whitespace after the closing quote.
  'da"',
  // Vim turns this exclusive motion linewise, but the engine has already trimmed its range.
  "d}",
]);

// The text matches vim; only where the cursor rests differs.
const CURSOR_DIFFERENCES = new Set([
  // Vim moves to the last inserted line.
  "2Ox<Esc>",
  // Vim leaves the cursor at the start of the line.
  ":s/a/z/g<CR>",
  // Vim rests on the closing brace's line.
  "di{",
  "di(",
]);

// Each row is real vim's result for those keys, with expandtab and shiftwidth=2.
describe.each([
  ["the composer", mountComposer],
  ["a textarea", mountTextarea],
])("%s matches real vim", (_surface, mount) => {
  const rows = reference.filter((row) => !ENGINE_DIFFERENCES.has(row.keys));
  it.each(rows)("$keys on $text", ({ text, start, keys, value, cursor }) => {
    Vim.resetVimGlobalState_();
    using vim = mount(text);
    const { editor: cm } = vim.host;
    vim.host.sendKey("<Esc>");
    cm.setCursor(start[0]!, start[1]!);
    for (const key of keys.match(/<[^>]+>|[\s\S]/g) ?? []) {
      if (typeInDialog(key)) continue;
      const handled = vim.host.sendKey(key === " " ? "<Space>" : key);
      if (handled || !cm.state.vim?.insertMode) continue;
      if (key === "<CR>") cm.replaceSelection("\n");
      else if (cm.state.overwrite) cm.overWriteSelection(key);
      else vim.typeCharacter(key);
    }
    if (cm.state.vim?.insertMode) vim.host.sendKey("<Esc>");
    expect(cm.getValue()).toBe(value);
    if (!CURSOR_DIFFERENCES.has(keys)) {
      expect([cm.getCursor().line, cm.getCursor().ch]).toEqual(cursor);
    }
  });
});
