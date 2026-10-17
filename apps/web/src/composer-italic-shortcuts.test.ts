import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDocJson,
  ComposerCodeExtension,
  ComposerItalicExtension,
  serializeEditorDoc,
} from "./composer-rich-text-doc";

/**
 * Types `text` at the end of `value`, the way the composer's editor would
 * receive it, and returns the stored Markdown and whether any text is italic.
 */
function typeAtEnd(value: string, text: string) {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({
        blockquote: false,
        bulletList: false,
        codeBlock: false,
        heading: false,
        horizontalRule: false,
        listItem: false,
        orderedList: false,
        trailingNode: false,
        code: false,
        italic: false,
      }),
      ComposerItalicExtension,
      ComposerCodeExtension,
    ],
    content: buildDocJson(value, (name) => ({ label: name, description: null })),
  });
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
  // What the view's `someProp("handleTextInput")` does, without mounting one:
  // offer the text to each extension plugin, then insert it if none took it.
  const { from, to } = editor.state.selection;
  const insert = () => editor.state.tr.insertText(text, from, to);
  const handled = editor.extensionManager.plugins.some((plugin) =>
    plugin.props.handleTextInput?.call(plugin, editor.view, from, to, text, insert),
  );
  if (!handled) editor.view.dispatch(insert());
  let italic = false;
  editor.state.doc.descendants((node) => {
    italic ||= node.marks.some((mark) => mark.type.name === "italic");
  });
  return { value: serializeEditorDoc(editor.state.doc).value, italic };
}

describe("ComposerItalicExtension", () => {
  it("keeps an underscore typed inside a snake_case word", () => {
    expect(typeAtEnd("clean _build and node", "_")).toEqual({
      value: "clean _build and node_",
      italic: false,
    });
  });

  it("leaves the underscore in a finished code span alone", () => {
    expect(typeAtEnd("clean `_build` and `node", "_")).toEqual({
      value: "clean `_build` and `node_",
      italic: false,
    });
  });

  it("still italicizes text typed between asterisks", () => {
    expect(typeAtEnd("clean *build", "*")).toEqual({ value: "clean *build*", italic: true });
  });
});
