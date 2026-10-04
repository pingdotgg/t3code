// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { addColumnAfter, addRowAfter, goToNextCell } from "@tiptap/pm/tables";
import { describe, expect, it } from "vite-plus/test";
import { richMarkdownExtensions } from "./RichMarkdownSurface";
import {
  parseRichMarkdown,
  serializeRichMarkdown,
  richSelectionSourceLines,
} from "./richMarkdownDocument";

describe("rich Markdown editing", () => {
  it("keeps source intact through actual editor normalization, paragraph editing and undo", () => {
    const source =
      "---\ntitle: Demo\n---\n\n# A title\n\nKeep _formatting_ [link](./next.md).\n\n```ts\nlet x = 1;\n```\n";
    const document = parseRichMarkdown(source);
    if ("reason" in document) throw new Error(document.reason);
    const editor = new Editor({ extensions: richMarkdownExtensions, content: document.content });
    try {
      expect(serializeRichMarkdown(document, editor.getJSON())).toBe(source);
      editor.commands.insertContentAt(2, "new ");
      expect(serializeRichMarkdown(document, editor.getJSON())).toContain("# Anew  title");
      expect(serializeRichMarkdown(document, editor.getJSON())).toContain(
        "Keep _formatting_ [link](./next.md).",
      );
      expect(serializeRichMarkdown(document, editor.getJSON())).toContain("```ts\nlet x = 1;\n```");
      editor.commands.undo();
      expect(serializeRichMarkdown(document, editor.getJSON())).toBe(source);
    } finally {
      editor.destroy();
    }
  });
  it("inserts table rows and columns and navigates cells with the same editor commands", () => {
    const document = parseRichMarkdown("| Left | Right |\n| --- | --- |\n| A | B |\n");
    if ("reason" in document) throw new Error(document.reason);
    const editor = new Editor({ extensions: richMarkdownExtensions, content: document.content });
    try {
      editor.commands.setTextSelection(4);
      expect(addColumnAfter(editor.state, editor.view.dispatch)).toBe(true);
      expect(addRowAfter(editor.state, editor.view.dispatch)).toBe(true);
      expect(goToNextCell(1)(editor.state, editor.view.dispatch)).toBe(true);
      const table = (editor.getJSON() as JSONContent).content![0]!;
      expect(table.content).toHaveLength(3);
      expect(table.content![0]!.content).toHaveLength(3);
      const saved = serializeRichMarkdown(document, editor.getJSON());
      expect(parseRichMarkdown(saved)).not.toHaveProperty("reason");
      expect(saved).toContain("Left");
      expect(saved).toContain("Right");
    } finally {
      editor.destroy();
    }
  });
  it("maps review notes past editor-only empty paragraphs and rejects a changed revision", () => {
    const document = parseRichMarkdown("# Heading\n\nBody\n");
    if ("reason" in document) throw new Error(document.reason);
    const json = structuredClone(document.content);
    json.content!.splice(1, 0, { type: "paragraph" });
    const contents = serializeRichMarkdown(document, json);
    expect(richSelectionSourceLines(document, json, 2, 2, contents)).toEqual({
      startLine: 5,
      endLine: 5,
    });
    expect(richSelectionSourceLines(document, json, 2, 2, contents + "external")).toBeNull();
  });
  it("saves formatting including trailing spaces and table code containing a pipe", () => {
    const source = "A paragraph.\n\n| Key |\n| --- |\n| Value |\n";
    const document = parseRichMarkdown(source);
    if ("reason" in document) throw new Error(document.reason);
    const editor = new Editor({ extensions: richMarkdownExtensions, content: document.content });
    try {
      editor.commands.setTextSelection({ from: 1, to: 3 });
      editor.commands.toggleBold();
      expect(serializeRichMarkdown(document, editor.getJSON())).toContain("**A** paragraph.");
      const json: JSONContent = editor.getJSON();
      json.content![1]!.content![1]!.content![0]!.content![0]!.content = [
        { type: "text", text: "x|y", marks: [{ type: "code" }] },
      ];
      const saved = serializeRichMarkdown(document, json);
      expect(saved).toContain("x\\|y");
      const reloaded = parseRichMarkdown(saved);
      if ("reason" in reloaded) throw new Error(reloaded.reason);
      expect(
        reloaded.blocks[1]?.json.content?.[1]?.content?.[0]?.content?.[0]?.content?.[0]?.text,
      ).toBe("x|y");
    } finally {
      editor.destroy();
    }
  });
  it("refuses to silently flatten an unsupported multi-line table cell", () => {
    const document = parseRichMarkdown("| Key |\n| --- |\n| Value |\n");
    if ("reason" in document) throw new Error(document.reason);
    const json = structuredClone(document.content);
    json.content![0]!.content![1]!.content![0]!.content![0]!.content = [
      { type: "text", text: "First" },
      { type: "hardBreak" },
      { type: "text", text: "Second" },
    ];
    expect(() => serializeRichMarkdown(document, json)).toThrow("cannot be represented safely");
    expect(document.source).toContain("Value");
  });
});
