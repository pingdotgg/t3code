import { describe, expect, it } from "vite-plus/test";

import { maskMarkdownFrontmatter } from "./markdownFrontmatter.ts";
import { markdownFrontmatterProperties } from "./markdownFrontmatterProperties.ts";

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

  it("leaves unterminated or non-leading fences alone", () => {
    expect(maskMarkdownFrontmatter("---\na: 1\n")).toBe("---\na: 1\n");
    expect(maskMarkdownFrontmatter("# A\n---\nb\n---\n")).toBe("# A\n---\nb\n---\n");
    expect(maskMarkdownFrontmatter("---\na: 1\n----\n")).toBe("---\na: 1\n----\n");
  });
});

describe("markdownFrontmatterProperties", () => {
  it("gives each top-level key its own row", () => {
    const skill = "---\r\nname: review\r\ndescription: Use when reviewing.\r\n---\r\n# Review\n";

    expect(markdownFrontmatterProperties(skill)).toEqual([
      { key: "name", value: "review", structured: false },
      { key: "description", value: "Use when reviewing.", structured: false },
    ]);
  });

  it("reads block scalars as text and writes lists and maps as inline YAML", () => {
    const markdown = [
      "---",
      "description: >-",
      "  Folded",
      "  text",
      "notes: |",
      "  one",
      "  two",
      "tools: [Read, Grep]",
      "blocked_by: []",
      "metadata:",
      "  version: 2",
      "draft: true",
      "owner:",
      "---",
      "# Body",
    ].join("\n");

    expect(markdownFrontmatterProperties(markdown)).toEqual([
      { key: "description", value: "Folded text", structured: false },
      { key: "notes", value: "one\ntwo", structured: false },
      { key: "tools", value: "[ Read, Grep ]", structured: true },
      { key: "blocked_by", value: "[]", structured: true },
      { key: "metadata", value: "{ version: 2 }", structured: true },
      { key: "draft", value: "true", structured: false },
      { key: "owner", value: "", structured: false },
    ]);
  });

  it("returns null when there is no readable map", () => {
    expect(markdownFrontmatterProperties("# No frontmatter\n")).toBeNull();
    expect(markdownFrontmatterProperties("---\n---\n# Body")).toBeNull();
    expect(markdownFrontmatterProperties("---\n- a\n- b\n---\n")).toBeNull();
    expect(markdownFrontmatterProperties("---\nname: [unclosed\n---\n")).toBeNull();
    expect(markdownFrontmatterProperties("---\nname: a\nname: b\n---\n")).toBeNull();
  });
});
