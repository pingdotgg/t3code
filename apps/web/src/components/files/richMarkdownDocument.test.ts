import { describe, expect, it } from "vite-plus/test";
import {
  parseRichMarkdown,
  serializeRichMarkdown,
  selectedMarkdownLines,
} from "./richMarkdownDocument";

const fixtures = [
  "---\ntitle: Test\ncustom: [1, 2]\n---\n\n# Heading\n\nA **bold** and _italic_ [relative link](./guide.md).\n\n```tsx\nconst a = `x`;\n```\n",
  "| Name | Value |\n| :--- | ---: |\n| One | **Two** |\n\n- [ ] pending\n- [x] done\n",
  '> Quote\n>\n> - Item\n\n1. First\n2. Second\n\n![Alt](./assets/image.png "title")\n',
  "# Windows\r\n\r\nParagraph.\r\n",
];
describe("rich Markdown source preservation", () => {
  it.each(fixtures)("preserves an unchanged document byte for byte", (source) => {
    const document = parseRichMarkdown(source);
    if ("reason" in document) throw new Error(document.reason);
    expect(serializeRichMarkdown(document, document.content)).toBe(source);
  });
  it("edits one block without normalizing front matter, code or other paragraphs", () => {
    const original = fixtures[0]!;
    const document = parseRichMarkdown(original);
    if ("reason" in document) throw new Error(document.reason);
    const changed = structuredClone(document.content);
    changed.content![1]!.content![0]!.text = "Changed ";
    const output = serializeRichMarkdown(document, changed);
    expect(
      output.startsWith(document.prefix + document.blocks[0]!.raw + document.blocks[0]!.separator),
    ).toBe(true);
    expect(output.endsWith(document.blocks[2]!.raw + document.blocks[2]!.separator)).toBe(true);
    expect(output).toContain("Changed **bold**");
    expect(parseRichMarkdown(output)).not.toHaveProperty("reason");
  });
  it.each([
    "<script>alert(1)</script>",
    "[link][ref]\n\n[ref]: /other",
    "```js {1}\ncode\n```",
    "[bad](javascript:alert%281%29)",
  ])("requires Source for unsupported or unsafe syntax", (source) => {
    expect(parseRichMarkdown(source)).toHaveProperty("reason");
  });
  it("invalidates captured source mappings after any source edit", () => {
    const document = parseRichMarkdown("---\ntitle: A\n---\n\n# Title\n\nBody\n");
    if ("reason" in document) throw new Error(document.reason);
    expect(selectedMarkdownLines(document, "block-1", document.source)).toEqual({
      startLine: 7,
      endLine: 7,
    });
    expect(selectedMarkdownLines(document, "block-1", document.source + "other")).toBeNull();
  });
});
