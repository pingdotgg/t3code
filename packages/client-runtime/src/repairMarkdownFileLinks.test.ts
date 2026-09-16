import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { repairMarkdownFileLinks } from "./repairMarkdownFileLinks.ts";

describe("repairMarkdownFileLinks", () => {
  it.each([
    "local/path/file.md",
    "./Release Notes.md",
    "/Users/demo/My Project/report.md",
    "C:/Users/demo/My Project/report.md",
    String.raw`C:\Users\demo\My Project\report.md`,
    "./output/",
    "/tmp/output/",
    "src/main.ts:12:3",
  ])("makes an unclosed destination clickable: %s", (path) => {
    const source = `[file](<${path})`;
    const repaired = repairMarkdownFileLinks(source);
    expect(repaired).toBe(`[file](<${path}>)`);
    const paragraph = unified().use(remarkParse).parse(repaired).children[0];
    expect(paragraph).toMatchObject({
      type: "paragraph",
      children: [{ type: "link", url: path }],
    });
    expect(repairMarkdownFileLinks(repaired)).toBe(repaired);
  });

  it("repairs multiple list items and formatted labels without changing surrounding text", () => {
    expect(
      repairMarkdownFileLinks("Files:\n\n- [**one**](<./one.md)\n- [two](<./two.md)\n\nDone."),
    ).toBe("Files:\n\n- [**one**](<./one.md>)\n- [two](<./two.md>)\n\nDone.");
  });

  it.each([
    ["", true],
    ["\\", false],
    ["\\\\", true],
    ["\\\\\\", false],
    ["!", false],
    ["\\!", true],
    ["\\\\!", false],
    ["\\\\\\!", true],
  ])("respects CommonMark escape parity after %j", (prefix, isLink) => {
    const source = `${prefix}[file](<./file.md)`;
    const repaired = repairMarkdownFileLinks(source);
    expect(repaired).toBe(isLink ? `${prefix}[file](<./file.md>)` : source);
    const paragraph = unified().use(remarkParse).parse(repaired).children[0];
    expect(
      paragraph?.type === "paragraph" && paragraph.children.some((node) => node.type === "link"),
    ).toBe(isLink);
  });

  it.each([
    "[file](<local/path/file.md>)",
    "[file](local/path/file.md)",
    "[web](<https://example.com/file.md)",
    "[route](</chat/settings)",
    "![image](<./image.png)",
    "`[file](<./file.md)`",
    "```md\n[file](<./file.md)\n```",
    "~~~md\n[file](<./file.md)\n~~~",
    "    [file](<./file.md)",
    '<div title="[file](<./file.md)">HTML</div>',
    '<span title="[file](<./file.md)">HTML</span>',
    String.raw`\[file](<./file.md)`,
    "[file](<./file.md",
    "[file](<./report (1).md)",
    '[file](<./file.md "title")',
    "![outer [file](<./file.md)][image]\n\n[image]: ./image.png",
    "[outer [file](<./file.md)](https://example.com)",
  ])("preserves other Markdown: %s", (source) => {
    expect(repairMarkdownFileLinks(source)).toBe(source);
  });

  it("preserves code examples while repairing a following link", () => {
    const source = "`[file](<./file.md)`\n\n[file](<./file.md)";
    expect(repairMarkdownFileLinks(source)).toBe("`[file](<./file.md)`\n\n[file](<./file.md>)");
  });
});
