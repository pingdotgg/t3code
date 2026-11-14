import { Editor, Node, type Extensions, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";
import { expect, it, vi } from "vite-plus/test";

import { serializeEditorDoc } from "../composer-rich-text-doc";
import { formatInlineContextReference } from "../lib/composerContextReferences";
import { captureComposerAttachmentInsertion } from "./composerAttachmentInsertion";
import { ComposerMarkdownSourceExtension } from "../composer-markdown-source";

const image = { kind: "image", contextId: "image_pending", label: "picture.png" } as const;

function createEditor(content: JSONContent, extensions: Extensions = []) {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ trailingNode: false }),
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
      ...extensions,
    ],
    content,
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  return editor;
}

it.each([
  { name: "continued typing", selected: "", insertedBefore: "" },
  { name: "replaced selected text", selected: "selected", insertedBefore: "" },
  { name: "an edit before the paste point", selected: "", insertedBefore: "prefix " },
])("keeps the paste point and current caret after $name", ({ selected, insertedBefore }) => {
  const editor = createEditor({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: `Before ${selected}` }] }],
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

it("maps source-marker rewrites before the paste point when the caret enters styled text", () => {
  const editor = createEditor(
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bold", marks: [{ type: "bold" }] },
            { type: "text", text: " after" },
          ],
        },
      ],
    },
    [ComposerMarkdownSourceExtension],
  );
  try {
    using _alive = vi.spyOn(editor, "isDestroyed", "get").mockReturnValue(false);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
    const insertion = captureComposerAttachmentInsertion(editor);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)));
    expect(editor.state.doc.textContent).toContain("**bold**");
    expect(insertion.insert([image])).toBe(true);
    expect(serializeEditorDoc(editor.state.doc).value).toBe(
      `**bold** after ${formatInlineContextReference(image)} `,
    );
  } finally {
    editor.destroy();
  }
});

it("gives up the paste point when the prompt is replaced wholesale", () => {
  const editor = createEditor({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }],
  });
  try {
    using _alive = vi.spyOn(editor, "isDestroyed", "get").mockReturnValue(false);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 7)));
    const insertion = captureComposerAttachmentInsertion(editor);
    editor.commands.setContent(
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Hello world @src/a.ts" }] },
        ],
      },
      { emitUpdate: false },
    );
    expect(insertion.insert([image])).toBe(false);
    expect(serializeEditorDoc(editor.state.doc).value).toBe("Hello world @src/a.ts");
  } finally {
    editor.destroy();
  }
});

it("keeps a pending image reference as text inside a code block", () => {
  const editor = createEditor({
    type: "doc",
    content: [{ type: "codeBlock", content: [{ type: "text", text: "Before " }] }],
  });
  try {
    using _alive = vi.spyOn(editor, "isDestroyed", "get").mockReturnValue(false);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
    const insertion = captureComposerAttachmentInsertion(editor);
    editor.view.dispatch(editor.state.tr.insertText("yaz"));
    expect(insertion.insert([image])).toBe(true);
    editor.view.dispatch(editor.state.tr.insertText("maya"));
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");
    expect(editor.state.doc.firstChild?.textContent).toBe(
      `Before ${formatInlineContextReference(image)} yazmaya`,
    );
  } finally {
    editor.destroy();
  }
});
