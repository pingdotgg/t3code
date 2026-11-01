import type { List } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { maskMarkdownFrontmatter } from "./markdownFrontmatter.ts";

describe("maskMarkdownFrontmatter", () => {
  it("blanks leading frontmatter without moving later offsets", () => {
    const markdown = "---\r\nname: skill\r\n---\r\n# Skill\n- [ ] item\n";
    const masked = maskMarkdownFrontmatter(markdown);

    expect(masked).toBe("   \r\n           \r\n   \r\n# Skill\n- [ ] item\n");
    expect(masked.indexOf("[ ]")).toBe(markdown.indexOf("[ ]"));
  });

  it("handles a byte order mark, CR line endings, and a ... closing fence", () => {
    expect(maskMarkdownFrontmatter("\uFEFF---\na: 1\n---\n# Body")).toBe("    \n    \n   \n# Body");
    expect(maskMarkdownFrontmatter("---\ra: 1\r...\r# Body")).toBe("   \r    \r   \r# Body");
    expect(maskMarkdownFrontmatter("---\n---\n# Body")).toBe("   \n   \n# Body");
  });

  it("keeps parser offsets aligned with the source when a byte order mark leads", () => {
    for (const indentation of ["", "   "]) {
      const markdown = `\uFEFF${indentation}- [ ] one\n- [ ] two\n`;
      const list = unified().use(remarkParse).parse(maskMarkdownFrontmatter(markdown))
        .children[0] as List;

      expect(list.type).toBe("list");
      expect(list.children.map((item) => markdown[item.position?.start.offset ?? -1])).toEqual([
        "-",
        "-",
      ]);
    }
    const fenced = "\uFEFF   ```\n   code\n   ```\n";
    expect(
      unified().use(remarkParse).parse(maskMarkdownFrontmatter(fenced)).children[0],
    ).toMatchObject({
      type: "code",
      value: "code",
    });
  });

  it("leaves unterminated or non-leading fences alone", () => {
    expect(maskMarkdownFrontmatter("---\na: 1\n")).toBe("---\na: 1\n");
    expect(maskMarkdownFrontmatter("# A\n---\nb\n---\n")).toBe("# A\n---\nb\n---\n");
    expect(maskMarkdownFrontmatter("---\na: 1\n----\n")).toBe("---\na: 1\n----\n");
  });
});
