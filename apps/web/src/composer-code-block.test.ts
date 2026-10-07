import { describe, expect, it } from "vite-plus/test";
import { Editor, Node } from "@tiptap/core";
import { newlineInCode } from "@tiptap/pm/commands";
import { TextSelection } from "@tiptap/pm/state";

import {
  CODE_BLOCK_INDENT,
  indentCodeBlock,
  indentLines,
  convertCodeFenceOnEnter,
  exitCodeBlockOnClosingFence,
  exitCodeBlockOnTrailingBlankLines,
  indentedNewlineInCodeBlock,
  leadingWhitespace,
  outdentLine,
} from "./composer-code-block";
import StarterKit from "@tiptap/starter-kit";

import {
  ComposerCodeBlockExtension,
  ComposerListExtensions,
  serializeEditorDoc,
} from "./composer-rich-text-doc";

const extensions = [
  StarterKit.configure({ codeBlock: false, trailingNode: false }),
  ComposerCodeBlockExtension,
  ...ComposerListExtensions,
  Node.create({
    name: "composer-mention",
    group: "inline",
    inline: true,
    atom: true,
    addAttributes: () => ({ path: { default: "" }, source: { default: "" } }),
  }),
];

describe("leadingWhitespace", () => {
  it("reads the indent a new line should inherit", () => {
    expect(leadingWhitespace("    nested()")).toBe("    ");
    expect(leadingWhitespace("\tnested()")).toBe("\t");
    expect(leadingWhitespace("flush()")).toBe("");
  });

  it("stops at the first non-space so code is never treated as indent", () => {
    expect(leadingWhitespace("  a  b")).toBe("  ");
  });
});

describe("outdentLine", () => {
  it("removes a full indent when there is one", () => {
    expect(outdentLine("    deep")).toBe("  deep");
  });

  /** Hand-indented lines should still outdent rather than refuse to move. */
  it("falls back to a single space or tab", () => {
    expect(outdentLine(" odd")).toBe("odd");
    expect(outdentLine("\ttabbed")).toBe("tabbed");
  });

  it("bottoms out instead of eating code", () => {
    expect(outdentLine("flush()")).toBe("flush()");
  });
});

describe("indentLines", () => {
  it("indents every line it is given", () => {
    expect(indentLines(["a", "b"], "in")).toEqual([
      `${CODE_BLOCK_INDENT}a`,
      `${CODE_BLOCK_INDENT}b`,
    ]);
  });

  /** Indenting a blank line would leave whitespace the user cannot see. */
  it("leaves blank lines alone", () => {
    expect(indentLines(["a", "", "b"], "in")).toEqual([
      `${CODE_BLOCK_INDENT}a`,
      "",
      `${CODE_BLOCK_INDENT}b`,
    ]);
  });

  it("outdents every line it is given", () => {
    expect(indentLines(["    a", "  b", "c"], "out")).toEqual(["  a", "b", "c"]);
  });
});

/** Builds an editor holding a single fenced block, with the caret placed by offset. */
function codeEditor(code: string, at?: { from: number; to?: number }) {
  const editor = new Editor({
    extensions,
    content: {
      type: "doc",
      content: [{ type: "codeBlock", content: [{ type: "text", text: code }] }],
    },
  });
  const start = 1;
  const from = start + (at?.from ?? code.length);
  const to = start + (at?.to ?? at?.from ?? code.length);
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
  );
  return editor;
}

const textOf = (editor: Editor) => editor.state.doc.textContent;

describe("indentedNewlineInCodeBlock", () => {
  it("carries the current indentation onto the new line", () => {
    const editor = codeEditor("function f() {\n  body()");
    const handled = indentedNewlineInCodeBlock(editor.state, (tr) => editor.view.dispatch(tr));
    expect(handled).toBe(true);
    expect(textOf(editor)).toBe("function f() {\n  body()\n  ");
  });

  /**
   * With no indent to carry there is nothing to add, so the default newline
   * should handle it and stay a single undo step.
   */
  it("declines an unindented line", () => {
    const editor = codeEditor("flush()");
    expect(indentedNewlineInCodeBlock(editor.state, (tr) => editor.view.dispatch(tr))).toBe(false);
    expect(textOf(editor)).toBe("flush()");
  });

  it("indents from the line the caret is on, not the last line", () => {
    const editor = codeEditor("    deep()\nflush()", { from: 10 });
    indentedNewlineInCodeBlock(editor.state, (tr) => editor.view.dispatch(tr));
    expect(textOf(editor)).toBe("    deep()\n    \nflush()");
  });

  it("replaces the selected text rather than keeping it", () => {
    const editor = codeEditor("  keep()DROP", { from: 8, to: 12 });
    indentedNewlineInCodeBlock(editor.state, (tr) => editor.view.dispatch(tr));
    expect(textOf(editor)).toBe("  keep()\n  ");
  });

  it("does nothing outside a code block", () => {
    const editor = new Editor({
      extensions,
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "  hi" }] }],
      },
    });
    expect(indentedNewlineInCodeBlock(editor.state, (tr) => editor.view.dispatch(tr))).toBe(false);
  });
});

/** Enter inside a fence, in the order the composer's key handler tries it. */
function pressEnter(editor: Editor) {
  const dispatch = (tr: Parameters<typeof editor.view.dispatch>[0]) => editor.view.dispatch(tr);
  return (
    exitCodeBlockOnTrailingBlankLines(editor.view) ||
    indentedNewlineInCodeBlock(editor.state, dispatch) ||
    newlineInCode(editor.state, dispatch)
  );
}

describe("exitCodeBlockOnTrailingBlankLines", () => {
  it("leaves the block once two blank lines end it", () => {
    const editor = codeEditor("flush()");
    pressEnter(editor);
    pressEnter(editor);
    expect(editor.state.doc.childCount).toBe(1);
    pressEnter(editor);
    expect(editor.state.doc.firstChild?.textContent).toBe("flush()");
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  /** Enter carries indentation, so the blank lines after nested code are not empty. */
  it("counts lines holding only carried indentation as blank", () => {
    const editor = codeEditor("  nested()");
    pressEnter(editor);
    pressEnter(editor);
    expect(editor.state.doc.childCount).toBe(1);
    pressEnter(editor);
    expect(editor.state.doc.firstChild?.textContent).toBe("  nested()");
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  /** An unclosed fence runs to the end of the draft, so leaving it must close it. */
  it("closes an unclosed fence on the way out", () => {
    const editor = codeEditor("flush()");
    editor.view.dispatch(editor.state.tr.setNodeAttribute(0, "close", ""));
    pressEnter(editor);
    pressEnter(editor);
    pressEnter(editor);
    expect(editor.state.doc.firstChild?.attrs.close).toBe("\n```");
  });

  it("stays in the block when the caret is not at its end", () => {
    const editor = codeEditor("a\n\n\nb", { from: 3 });
    expect(exitCodeBlockOnTrailingBlankLines(editor.view)).toBe(false);
  });
});

describe("exitCodeBlockOnClosingFence", () => {
  const exit = (editor: Editor) =>
    exitCodeBlockOnClosingFence(editor.state, (tr) => editor.view.dispatch(tr));

  it("ends the block at a typed closing fence and starts a line after it", () => {
    const editor = codeEditor("const a = 1\n```");
    editor.view.dispatch(editor.state.tr.setNodeAttribute(0, "language", "ts"));
    expect(exit(editor)).toBe(true);
    editor.view.dispatch(editor.state.tr.insertText("explain this"));
    expect(serializeEditorDoc(editor.state.doc).value).toBe(
      "```ts\nconst a = 1\n```\nexplain this",
    );
  });

  it("moves the lines after the fence out of the block", () => {
    const editor = codeEditor("a\n```\nb", { from: "a\n```".length });
    expect(exit(editor)).toBe(true);
    expect(serializeEditorDoc(editor.state.doc).value).toBe("```\na\n```\n\nb");
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.state.selection.$from.parent.textContent).toBe("");
  });

  it.each([
    ["a line that cannot close the fence", "a\n``", undefined],
    ["a caret before the end of the line", "a\n```", { from: "a\n``".length }],
  ])("ignores %s", (_, code, at) => {
    expect(exit(codeEditor(code, at))).toBe(false);
  });
});

describe("indentCodeBlock", () => {
  it("inserts an indent at a collapsed caret", () => {
    const editor = codeEditor("ab", { from: 1 });
    expect(indentCodeBlock(editor.state, "in", (tr) => editor.view.dispatch(tr))).toBe(true);
    expect(textOf(editor)).toBe(`a${CODE_BLOCK_INDENT}b`);
  });

  it("indents every line a selection touches", () => {
    const editor = codeEditor("one\ntwo\nthree", { from: 1, to: 9 });
    indentCodeBlock(editor.state, "in", (tr) => editor.view.dispatch(tr));
    expect(textOf(editor)).toBe("  one\n  two\n  three");
  });

  /** A selection of whole lines ends at the start of the next one, which it does not touch. */
  it("leaves the line a selection ends at the start of", () => {
    const editor = codeEditor("one\ntwo", { from: 0, to: 4 });
    indentCodeBlock(editor.state, "in", (tr) => editor.view.dispatch(tr));
    expect(textOf(editor)).toBe("  one\ntwo");
  });

  it("outdents every line a selection touches", () => {
    const editor = codeEditor("  one\n  two", { from: 2, to: 9 });
    indentCodeBlock(editor.state, "out", (tr) => editor.view.dispatch(tr));
    expect(textOf(editor)).toBe("one\ntwo");
  });

  /** Repeated Tab presses should keep working on the same block. */
  it("keeps the selection across the shifted lines", () => {
    const editor = codeEditor("one\ntwo", { from: 0, to: 7 });
    indentCodeBlock(editor.state, "in", (tr) => editor.view.dispatch(tr));
    indentCodeBlock(editor.state, "in", (tr) => editor.view.dispatch(tr));
    expect(textOf(editor)).toBe("    one\n    two");
  });

  it("reports handled when outdenting can go no further, so Tab never escapes the editor", () => {
    const editor = codeEditor("one\ntwo", { from: 0, to: 7 });
    expect(indentCodeBlock(editor.state, "out", (tr) => editor.view.dispatch(tr))).toBe(true);
    expect(textOf(editor)).toBe("one\ntwo");
  });

  it("does nothing outside a code block", () => {
    const editor = new Editor({
      extensions,
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
      },
    });
    expect(indentCodeBlock(editor.state, "in", (tr) => editor.view.dispatch(tr))).toBe(false);
  });
});

describe("selections across two identical fences", () => {
  /** Two structurally equal code blocks; the selection spans from one into the other. */
  function twoBlockEditor() {
    const block = { type: "codeBlock", content: [{ type: "text", text: "  a" }] };
    const editor = new Editor({ extensions, content: { type: "doc", content: [block, block] } });
    // First block: 1..4 (text "  a" occupies 1..4); second block starts at 5.
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2, 7)),
    );
    return editor;
  }

  it("leaves Tab and Enter alone rather than editing through the boundary", () => {
    const editor = twoBlockEditor();
    const before = editor.getJSON();
    expect(indentCodeBlock(editor.state, "in", (tr) => editor.view.dispatch(tr))).toBe(false);
    expect(indentedNewlineInCodeBlock(editor.state, (tr) => editor.view.dispatch(tr))).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });
});

describe("convertCodeFenceOnEnter", () => {
  /** Builds an editor holding one paragraph with the caret at its end. */
  function paragraphEditor(text: string) {
    const editor = new Editor({
      extensions,
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
    });
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1 + text.length)),
    );
    return editor;
  }

  it.each([
    ["```", "```", ""],
    ["```ts", "```", "ts"],
    ["~~~py", "~~~", "py"],
    ["````", "````", ""],
    ["```ts title=example", "```", "ts title=example"],
    ["``` js", "```", " js"],
  ])("turns %s into a code block", (text, fence, language) => {
    const editor = paragraphEditor(text);
    expect(convertCodeFenceOnEnter(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true);
    const block = editor.state.doc.firstChild!;
    expect(block.type.name).toBe("codeBlock");
    expect(block.attrs).toMatchObject({ fence, language, close: `\n${fence}` });
    expect(block.textContent).toBe("");
    // The caret belongs inside the new block, ready for the first line.
    expect(editor.state.selection.from).toBe(1);
  });

  it.each(["``", "text ```", "```a`b"])("leaves %s alone", (text) => {
    const editor = paragraphEditor(text);
    expect(convertCodeFenceOnEnter(editor.state, (tr) => editor.view.dispatch(tr))).toBe(false);
  });

  it("refuses to open a fence inside a list item", () => {
    const text = "```ts";
    const editor = new Editor({
      extensions,
      content: {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text }] }],
              },
            ],
          },
        ],
      },
    });
    // Inside listItem > paragraph: position 3 is the paragraph start.
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3 + text.length)),
    );
    const before = editor.getJSON();
    expect(convertCodeFenceOnEnter(editor.state, (tr) => editor.view.dispatch(tr))).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it("keeps a chip's source in the info string", () => {
    const editor = new Editor({
      extensions,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "```ts " },
              { type: "composer-mention", attrs: { path: "a.md", source: "@a.md" } },
            ],
          },
        ],
      },
    });
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
    expect(convertCodeFenceOnEnter(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.language).toBe("ts @a.md");
  });

  it("ignores a fence with the caret before its end", () => {
    const editor = paragraphEditor("```ts");
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)));
    expect(convertCodeFenceOnEnter(editor.state, (tr) => editor.view.dispatch(tr))).toBe(false);
  });
});
