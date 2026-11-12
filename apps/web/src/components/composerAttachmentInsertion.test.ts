import { Editor, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";
import { expect, it, vi } from "vite-plus/test";

import { serializeEditorDoc } from "../composer-rich-text-doc";
import { formatInlineContextReference } from "../lib/composerContextReferences";
import { captureComposerAttachmentInsertion } from "./composerAttachmentInsertion";

it.each([
  { name: "continued typing", selected: "", insertedBefore: "" },
  { name: "replaced selected text", selected: "selected", insertedBefore: "" },
  { name: "an edit before the paste point", selected: "", insertedBefore: "prefix " },
])("keeps the paste point and current caret after $name", ({ selected, insertedBefore }) => {
  const image = { kind: "image", contextId: "image_pending", label: "picture.png" } as const;
  const editor = new Editor({
    extensions: [
      StarterKit,
      Node.create({
        name: "composer-context-reference",
        group: "inline",
        inline: true,
        atom: true,
        addAttributes: () => ({
          kind: { default: "" },
          contextId: { default: "" },
          label: { default: "" },
          source: { default: "" },
        }),
      }),
    ],
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: `Before ${selected}` }] }],
    },
  });
  try {
    // Headless Tiptap has no mounted view, so its lifecycle getter reports destroyed.
    using _alive = vi.spyOn(editor, "isDestroyed", "get").mockReturnValue(false);
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 8, 8 + selected.length)),
    );
    const insertion = captureComposerAttachmentInsertion(editor);
    if (insertedBefore) editor.view.dispatch(editor.state.tr.insertText(insertedBefore, 1));
    editor.view.dispatch(editor.state.tr.insertText("yaz"));
    expect(insertion.insert([image])).toBe(true);
    expect(serializeEditorDoc(editor.state.doc).value).toContain(
      formatInlineContextReference(image),
    );
    insertion.dispose();
    editor.view.dispatch(editor.state.tr.insertText("maya"));

    expect(serializeEditorDoc(editor.state.doc).value).toBe(
      `${insertedBefore}Before ${formatInlineContextReference(image)} yazmaya`,
    );
  } finally {
    editor.destroy();
  }
});
