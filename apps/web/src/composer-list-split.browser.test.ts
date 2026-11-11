import { Editor } from "@tiptap/core";
import { TaskList } from "@tiptap/extension-task-list";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDocJson,
  buildTiptapContent,
  ComposerBlockExtensions,
  ComposerCodeBlockExtension,
  ComposerListExtensions,
  ComposerTaskItemExtension,
  serializeEditorDoc,
} from "./composer-rich-text-doc";

// ProseMirror's DOM observer can flush on a timer after a test ends, which
// throws once its DOM is gone, so every editor is acquired with `using`.
function makeEditor(value: string): Editor & Disposable {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({
        bulletList: false,
        orderedList: false,
        listItem: false,
        codeBlock: false,
        blockquote: false,
        heading: false,
        horizontalRule: false,
        trailingNode: false,
        listKeymap: false,
      }),
      ...ComposerListExtensions,
      TaskList,
      ComposerTaskItemExtension,
      ComposerCodeBlockExtension,
      ...ComposerBlockExtensions,
    ],
    content: buildDocJson(value, (name) => ({ label: name, description: null })),
  });
  return Object.assign(editor, { [Symbol.dispose]: () => editor.destroy() });
}

function placeCaret(editor: Editor, text: string, offset = 0) {
  let caret = -1;
  editor.state.doc.descendants((node, pos) => {
    if (caret < 0 && node.isText && node.text!.includes(text)) {
      caret = pos + node.text!.indexOf(text) + offset;
    }
  });
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, caret)));
}

function storedDraft(editor: Editor) {
  const stored = serializeEditorDoc(editor.state.doc).value;
  using reloaded = makeEditor(stored);
  expect(reloaded.state.doc.toString()).toBe(editor.state.doc.toString());
  return stored;
}

describe("Backspace at the start of a line", () => {
  it.each([
    ["- a\n```\nl1\nl2\n```", "- a\nl1\nl2"],
    ["p\n```ts\nl1\n```", "p\nl1"],
  ])("removes the fence of %j rather than joining its code up", (value, expected) => {
    using editor = makeEditor(value);
    placeCaret(editor, "l1");
    editor.commands.keyboardShortcut("Backspace");
    expect(storedDraft(editor)).toBe(expected);
  });

  // Neither item has a list of its own kind one level up to lift into.
  it.each([
    ["- a\n  - [ ] x\n  - [ ] y", "- a\n  - [ ] xy"],
    ["- [ ] a\n  - x\n  - y", "- [ ] a\n  - xy"],
    ["- a\n  - [ ] y\n  - [ ] q", "- ay\n  - [ ] q"],
  ])("joins y in %j onto the line above", (value, expected) => {
    using editor = makeEditor(value);
    placeCaret(editor, "y");
    editor.commands.keyboardShortcut("Backspace");
    expect(storedDraft(editor)).toBe(expected);
  });

  it("removes an empty checkbox under a bullet", () => {
    using editor = makeEditor("- a\n  - [ ] x\n  - [ ]");
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
    editor.commands.keyboardShortcut("Backspace");
    expect(storedDraft(editor)).toBe("- a\n  - [ ] x");
  });
});

describe("blocks that a list item or quote cannot hold", () => {
  it("puts lines pasted at the end of an item after the list", () => {
    using editor = makeEditor("- a");
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
    const lines = buildTiptapContent("one\ntwo", (name) => ({ label: name, description: null }));
    editor.commands.insertContent(lines);
    expect(storedDraft(editor)).toBe("- a\none\ntwo");
  });
});
