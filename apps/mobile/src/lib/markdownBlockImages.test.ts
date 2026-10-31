import { describe, expect, it } from "vite-plus/test";
import { markdownWithBlockImages, parseMarkdownDocument } from "./markdownDocument";

describe("images inside running text", () => {
  it("moves each image into its own paragraph", () => {
    expect(markdownWithBlockImages("Imports. ![a](a.png)\n\nPreview ![b](b.png) and more.")).toBe(
      "Imports.\n\n![a](a.png)\n\nPreview\n\n![b](b.png)\n\nand more.",
    );
    expect(markdownWithBlockImages("Shots ![a](a.png) ![b][b]\n\n[b]: b.png")).toBe(
      "Shots\n\n![a](a.png)\n\n![b][b]\n\n[b]: b.png",
    );
    expect(markdownWithBlockImages("Shots ![a](a.png)  \\\n![b](b.png)")).toBe(
      "Shots\n\n![a](a.png)\n\n![b](b.png)",
    );
  });

  it("keeps the new paragraphs inside lists and blockquotes", () => {
    expect(markdownWithBlockImages("1. **Imports.** Done. ![a](a.png)")).toBe(
      "1. **Imports.** Done.\n\n   ![a](a.png)",
    );
    expect(markdownWithBlockImages("- One ![a](a.png)\nnext")).toBe(
      "- One\n\n  ![a](a.png)\n\n  next",
    );
    expect(markdownWithBlockImages("> Quoted ![a](a.png)")).toBe("> Quoted\n>\n> ![a](a.png)");
    expect(markdownWithBlockImages("- [x] Done ![a](a.png)")).toBe("- [x] Done\n\n  ![a](a.png)");
    const continued = parseMarkdownDocument(markdownWithBlockImages("See ![a](a.png)\n    > keep"));
    expect(continued.children.at(-1)).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", value: "> keep" }],
    });
    expect(markdownWithBlockImages("> See ![a](a.png)\ncontinued")).toBe(
      "> See\n>\n> ![a](a.png)\n>\n> continued",
    );
    const preceding = parseMarkdownDocument(markdownWithBlockImages("See\n    > ![a](a.png)"));
    expect(preceding.children[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", value: "See\n>" }],
    });
    expect(markdownWithBlockImages("> See ![a](a.png)\n    > keep")).toBe(
      "> See\n>\n> ![a](a.png)\n>\n> \\> keep",
    );
    expect(markdownWithBlockImages("> See\n    > ![a](a.png)")).toBe(
      "> See\n    >\n>\n> ![a](a.png)",
    );
    expect(markdownWithBlockImages("10. > See ![a](a.png)\n    > keep")).toBe(
      "10. > See\n    >\n    > ![a](a.png)\n    >\n    > keep",
    );
    expect(markdownWithBlockImages("10. intro\n\n    > See ![a](a.png)\n    > keep")).toBe(
      "10. intro\n\n    > See\n    >\n    > ![a](a.png)\n    >\n    > keep",
    );
  });

  it("keeps text after an image from opening a block", () => {
    for (const [suffix, escaped] of [
      ["# x", "\\# x"],
      ["- x", "\\- x"],
      ["* x", "\\* x"],
      ["*", "\\*"],
      ["2. x", "2\\. x"],
      ["> x", "\\> x"],
      ["---", "\\---"],
      ["***", "\\***"],
      ["*emphasis* x", "*emphasis* x"],
      ["Hello\n2. x", "Hello\n2. x"],
    ]) {
      expect(markdownWithBlockImages(`See ![a](a.png) ${suffix}`)).toBe(
        `See\n\n![a](a.png)\n\n${escaped}`,
      );
    }
  });

  it("preserves reference-like text and fences after images", () => {
    for (const suffix of ["[id]: target.png", "~~~js\nconst x = 1", "```js\nconst x = 1"]) {
      const document = parseMarkdownDocument(markdownWithBlockImages(`See ![a](a.png) ${suffix}`));
      expect(document.children.map((node) => node.type)).toEqual([
        "paragraph",
        "paragraph",
        "paragraph",
      ]);
      const last = document.children.at(-1);
      expect(last?.type === "paragraph" && last.children).toMatchObject([
        { type: "text", value: suffix },
      ]);
    }
  });

  it("preserves links and code next to images", () => {
    expect(markdownWithBlockImages("See ![a](a.png) [id]: target.png\n\n[id]: original.png")).toBe(
      "See\n\n![a](a.png)\n\n[id]\\: target.png\n\n[id]: original.png",
    );
    expect(markdownWithBlockImages("See ![a](a.png) `code`")).toBe("See\n\n![a](a.png)\n\n`code`");
    const bracketedCode = "See ![a](a.png) [`x]: y`]";
    expect(markdownWithBlockImages(bracketedCode)).toBe(bracketedCode);
    const multiline = "See ![a](a.png) ```line\ncode```";
    expect(markdownWithBlockImages(multiline)).toBe(multiline);
  });

  it("leaves images that already start their own line", () => {
    for (const markdown of [
      "Text\n\n![a](a.png)",
      "- ![a](a.png)",
      "See [![badge](b.svg)](https://example.com) here",
      "`![a](a.png)` in code",
      "||secret ![shot](shot.png) caption||",
      "Title\n--- ![a](a.png)",
      "Title\n=== ![a](a.png)",
    ]) {
      expect(markdownWithBlockImages(markdown)).toBe(markdown);
    }
  });
});
