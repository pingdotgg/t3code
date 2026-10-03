import { Editor } from "@tiptap/core";
import { TaskList } from "@tiptap/extension-task-list";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDocJson,
  ComposerListExtensions,
  ComposerTaskItemExtension,
  serializeEditorDoc,
} from "./composer-rich-text-doc";

/**
 * Splits the last item of `value` the way Shift+Enter does, types `b`, and
 * returns the stored Markdown. Tiptap carries every attribute left at the
 * default `keepOnSplit: true` onto the new item and merges the overrides on
 * top, so the new item must keep the source marker, indent and spacing.
 */
function splitLastItem(value: string, type: "listItem" | "taskItem", overrides: object) {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({
        bulletList: false,
        orderedList: false,
        listItem: false,
        codeBlock: false,
        trailingNode: false,
      }),
      ...ComposerListExtensions,
      TaskList,
      ComposerTaskItemExtension,
    ],
    content: buildDocJson(value, (name) => ({ label: name, description: null })),
  });
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
