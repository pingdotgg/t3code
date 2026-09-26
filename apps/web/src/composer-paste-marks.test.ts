import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vite-plus/test";

import { serializeEditorDoc } from "./composer-rich-text-doc";
import { setTypingMarksAfterPaste } from "./composer-paste-marks";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
  },
  marks: { bold: {}, italic: {} },
});

describe("typing after pasted formatting", () => {
  it("continues in plain text after a bold paste at the end of a line", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("bold", [schema.marks.bold!.create()])]),
    ]);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 5) });

    expect(serializeEditorDoc(state.apply(state.tr.insertText(" plain")).doc).value).toBe(
      "**bold plain**",
    );
    const continued = state.apply(setTypingMarksAfterPaste(state)!);
    expect(serializeEditorDoc(continued.apply(continued.tr.insertText(" plain")).doc).value).toBe(
      "**bold** plain",
    );
  });

  it("uses the formatting of following text when pasting in the middle", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("bold", [schema.marks.bold!.create()]),
        schema.text("tail", [schema.marks.italic!.create()]),
      ]),
    ]);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 5) });
    const continued = state.apply(setTypingMarksAfterPaste(state)!);
    const withText = continued.apply(continued.tr.insertText("x")).doc;

    expect(withText.child(0).child(1).text).toBe("xtail");
    expect(
      withText
        .child(0)
        .child(1)
        .marks.map((mark) => mark.type.name),
    ).toEqual(["italic"]);
  });
});
