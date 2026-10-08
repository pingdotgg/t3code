// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { TaskList } from "@tiptap/extension-task-list";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  backspaceAcrossList,
  buildDocJson,
  buildTiptapContent,
  ComposerBlockExtensions,
  ComposerCodeBlockExtension,
  ComposerListExtensions,
  ComposerTaskItemExtension,
  convertBulletItemToTask,
  deleteAcrossList,
  serializeEditorDoc,
  splitOrLiftListItem,
} from "./composer-rich-text-doc";

// ProseMirror's DOM observer can flush on a timer after a test ends, which
// throws once jsdom is torn down, so every editor is destroyed after its test.
const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

/**
 * Splits the last item of `value` the way Shift+Enter does, types `b`, and
 * returns the stored Markdown. Tiptap carries every attribute left at the
 * default `keepOnSplit: true` onto the new item and merges the overrides on
 * top, so the new item must keep the source marker, indent and spacing.
 */
function makeEditor(value: string) {
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
  editors.push(editor);
  return editor;
}

function splitLastItem(value: string, type: "listItem" | "taskItem", overrides: object) {
  const editor = makeEditor(value);
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
  editor.commands.splitListItem(type, overrides);
  editor.view.dispatch(editor.state.tr.insertText("b"));
  return serializeEditorDoc(editor.state.doc).value;
}

describe("splitting a list item", () => {
  it.each([
    ["* a", { space: " " }, "* a\n* b"],
    ["+ a", { space: " " }, "+ a\n+ b"],
    ["- p\n  - a", { space: " " }, "- p\n  - a\n  - b"],
    ["3) a", { marker: "4)", space: " " }, "3) a\n4) b"],
  ])("keeps the source marker and indent of %s", (value, overrides, expected) => {
    expect(splitLastItem(value, "listItem", overrides)).toBe(expected);
  });

  it("keeps the indent of a nested task", () => {
    expect(splitLastItem("- [ ] p\n  - [ ] a", "taskItem", { checked: false })).toBe(
      "- [ ] p\n  - [ ] a\n  - [ ] b",
    );
  });
});

/** Puts the caret `offset` characters into the first text node holding `text`. */
function placeCaret(editor: Editor, text: string, offset = 0) {
  let caret = -1;
  editor.state.doc.descendants((node, pos) => {
    if (caret < 0 && node.isText && node.text!.includes(text)) {
      caret = pos + node.text!.indexOf(text) + offset;
    }
  });
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, caret)));
}

/** The stored draft, after checking a rebuild from it gives back the same document. */
function storedDraft(editor: Editor) {
  const stored = serializeEditorDoc(editor.state.doc).value;
  expect(makeEditor(stored).state.doc.toString()).toBe(editor.state.doc.toString());
  return stored;
}

describe("Shift+Enter twice on an item", () => {
  // The second Shift+Enter lifts the new empty item one level. The stored
  // draft must write it at its new depth, so a rebuild from that draft gives
  // back the document the user is looking at.
  it.each([
    ["- a\n  - x", "- a\n  - x\n- b"],
    ["* a\n  * x", "* a\n  * x\n* b"],
    ["1. a\n   1. x", "1. a\n   1. x\n2. b"],
    ["- a\n  - x\n- c", "- a\n  - x\n- b\n- c"],
    ["- a\n  - x\n  - y", "- a\n  - x\n- b\n  - y"],
    ["- [ ] a\n  - [ ] x", "- [ ] a\n  - [ ] x\n- [ ] b"],
    ["- [x] a\n  - [ ] x\n- [ ] c", "- [x] a\n  - [ ] x\n- [ ] b\n- [ ] c"],
  ])("after x in %j writes %j", (value, expected) => {
    const editor = makeEditor(value);
    let caret = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "x") caret = pos + 1;
    });
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, caret)),
    );
    expect(splitOrLiftListItem(editor)).toBe(true);
    expect(splitOrLiftListItem(editor)).toBe(true);
    editor.view.dispatch(editor.state.tr.insertText("b"));
    const stored = serializeEditorDoc(editor.state.doc).value;
    expect(stored).toBe(expected);
    // Same nesting after a rebuild; spacing defaults may differ but write the same.
    expect(makeEditor(stored).state.doc.toString()).toBe(editor.state.doc.toString());
  });
});

describe("Shift+Enter in the middle of an ordered list", () => {
  it.each([
    ["1. a\n2. x\n3. c\n4. d", "1. a\n2. x\n3. b\n4. c\n5. d"],
    ["1) a\n2) x\n3) c", "1) a\n2) x\n3) b\n4) c"],
    ["1. a\n   1. x\n   2. c\n2. d", "1. a\n   1. x\n   2. b\n   3. c\n2. d"],
  ])("after x in %j writes %j", (value, expected) => {
    const editor = makeEditor(value);
    placeCaret(editor, "x", 1);
    expect(splitOrLiftListItem(editor)).toBe(true);
    editor.view.dispatch(editor.state.tr.insertText("b"));
    expect(storedDraft(editor)).toBe(expected);
  });
});

describe("Shift+Enter on an empty task under a bullet", () => {
  // There is no task list one level up to move it into, and the item cannot
  // hold a second line, so the draft stays what the editor shows.
  it.each(["- a\n  - [ ] x", "- [ ] a\n  - x"])("in %j keeps the draft honest", (value) => {
    const editor = makeEditor(value);
    placeCaret(editor, "x", 1);
    splitOrLiftListItem(editor);
    splitOrLiftListItem(editor);
    storedDraft(editor);
  });
});

describe("Backspace at the start of a line", () => {
  it.each([
    ["- a\n  - x", "x", "- a\n- x"],
    ["- a\n  - x\n  - y", "x", "- a\n- x\n  - y"],
    ["- [ ] a\n  - [ ] x", "x", "- [ ] a\n- [ ] x"],
    ["- a\n- b\n- c", "b", "- a\nb\n- c"],
    // A task under a bullet has no task list to move into, so it joins up.
    ["- a\n  - [ ] x", "x", "- ax"],
    ["- a\n  - x\nb", "b", "- a\n  - xb"],
    ["1. a\nb", "b", "1. ab"],
  ])("in %j at %s writes %j", (value, at, expected) => {
    const editor = makeEditor(value);
    placeCaret(editor, at);
    expect(backspaceAcrossList(editor)).toBe(true);
    expect(storedDraft(editor)).toBe(expected);
  });

  it.each([
    ["- a\n```\nl1\nl2\n```", "- a\nl1\nl2"],
    ["p\n```ts\nl1\n```", "p\nl1"],
  ])("removes the fence of %j rather than joining its code up", (value, expected) => {
    const editor = makeEditor(value);
    placeCaret(editor, "l1");
    editor.commands.keyboardShortcut("Backspace");
    expect(storedDraft(editor)).toBe(expected);
  });
});

describe("Delete at the end of a line", () => {
  it.each([
    ["- a\n- b", "- ab"],
    ["- a\n  - x\n- c", "- ax\n- c"],
    ["- a\n\nb", "- a\nb"],
  ])("in %j writes %j", (value, expected) => {
    const editor = makeEditor(value);
    placeCaret(editor, "a", 1);
    expect(deleteAcrossList(editor)).toBe(true);
    expect(storedDraft(editor)).toBe(expected);
  });

  it.each(["- a\n```\nl1\n```", "a\n```\nl1\n```"])("leaves the fence in %j alone", (value) => {
    const editor = makeEditor(value);
    placeCaret(editor, "a", 1);
    editor.commands.keyboardShortcut("Delete");
    expect(storedDraft(editor)).toBe(value);
  });
});

describe("blocks that a list item or quote cannot hold", () => {
  it("puts lines pasted at the end of an item after the list", () => {
    const editor = makeEditor("- a");
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
    const lines = buildTiptapContent("one\ntwo", (name) => ({ label: name, description: null }));
    editor.commands.insertContent(lines);
    expect(storedDraft(editor)).toBe("- a\none\ntwo");
  });

  it("will not make a task list inside a quote", () => {
    const editor = makeEditor("> q");
    placeCaret(editor, "q");
    expect(editor.commands.wrapInList("taskList")).toBe(false);
    expect(storedDraft(editor)).toBe("> q");
  });
});

describe("[ ] typed at the start of a bullet item", () => {
  // The value holds `[ ]` already; the rule fires on the space after it.
  it.each([
    ["* [ ]x", "- [ ] x"],
    ["* a\n* [ ]x\n* c", "* a\n- [ ] x\n* c"],
    ["- a\n  * [ ]x", "- a\n  - [ ] x"],
    ["- a\n  - [ ]x\n  - y", "- a\n  - [ ] x\n  - y"],
    ["- [ ]x\n  - y", "- [ ] x\n  - y"],
    ["-   [ ]x", "-   [ ] x"],
  ])("makes the item in %j a task where it stands", (value, expected) => {
    const editor = makeEditor(value);
    placeCaret(editor, "[ ]x");
    const from = editor.state.selection.from;
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from + 3)),
    );
    const { tr } = editor.state;
    convertBulletItemToTask(tr, from, from + 3, false);
    editor.view.dispatch(tr);
    expect(editor.state.selection.$from.parent.textContent).toBe("x");
    expect(editor.state.selection.$from.parentOffset).toBe(0);
    expect(storedDraft(editor)).toBe(expected);
  });
});

describe("a rule at the end of the draft", () => {
  it("keeps an empty line after it to type on", () => {
    const editor = makeEditor("a\n---");
    // Removing the line after the rule puts one straight back.
    editor.view.dispatch(
      editor.state.tr.delete(editor.state.doc.content.size - 2, editor.state.doc.content.size),
    );
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    expect(storedDraft(editor)).toBe("a\n---");
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
    editor.view.dispatch(editor.state.tr.insertText("b"));
    expect(storedDraft(editor)).toBe("a\n---\nb");
  });
});
