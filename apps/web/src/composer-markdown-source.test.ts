import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { expect, it } from "vite-plus/test";

import { ComposerMarkdownSourcePlugin } from "./composer-markdown-source";

it("preserves a long source line while the caret moves", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "paragraph+" },
      paragraph: { content: "text*" },
      text: {},
    },
    marks: { bold: {} },
  });
  const value = "x".repeat(150_000) + " **b**";
  const doc = schema.node("doc", null, [schema.node("paragraph", null, schema.text(value))]);
  const state = EditorState.create({ doc, plugins: [ComposerMarkdownSourcePlugin] });
  const moved = state.apply(state.tr.setSelection(TextSelection.create(doc, 5)));
  expect(moved.doc).toBe(doc);
  expect(moved.doc.textContent).toBe(value);
});
