import { describe, expect, it } from "vite-plus/test";

import {
  maskMarkdownFrontmatter,
  patchTaskFrontmatter,
  readTaskFrontmatter,
} from "./markdownFrontmatter.ts";

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

describe("patchTaskFrontmatter", () => {
  it("updates task fields while retaining comments, unknown metadata, BOM, CRLF, and body", () => {
    const markdown =
      '\uFEFF---\r\nid: 3a18fa11-3485-43ae-b00e-2ab17f02ff78\r\ntitle: "Old title" # title comment\r\nstate: Waiting on vendor # state comment\r\npinned: false # pin comment\r\ncustom: [one, two] # keep me\r\n---\r\n# Body\r\n';

    expect(
      patchTaskFrontmatter(markdown, {
        title: "New: task ☃",
        state: "In progress",
        pinned: true,
      }),
    ).toBe(
      '\uFEFF---\r\nid: 3a18fa11-3485-43ae-b00e-2ab17f02ff78\r\ntitle: "New: task ☃" # title comment\r\nstate: "In progress" # state comment\r\npinned: true # pin comment\r\ncustom: [one, two] # keep me\r\n---\r\n# Body\r\n',
    );
  });

  it("adds missing metadata and an initial frontmatter block using the file line endings", () => {
    expect(
      patchTaskFrontmatter("---\n---\nBody", { title: "Task", state: "", pinned: false }),
    ).toBe('---\ntitle: "Task"\nstate:\npinned: false\n---\nBody');

    expect(
      patchTaskFrontmatter("---\r\ncustom: keep\r\n---\r\nBody", {
        title: "Task",
        state: "",
        pinned: false,
      }),
    ).toBe('---\r\ncustom: keep\r\ntitle: "Task"\r\nstate:\r\npinned: false\r\n---\r\nBody');

    expect(patchTaskFrontmatter("# Body\n", { title: "Task", state: "Later", pinned: true })).toBe(
      '---\ntitle: "Task"\nstate: "Later"\npinned: true\n---\n# Body\n',
    );

    expect(
      patchTaskFrontmatter(
        "---\ntitle: Task\nstate: # keep this comment\npinned: false\n---\nBody",
        { title: "Task", state: "Ready", pinned: false },
      ),
    ).toBe('---\ntitle: "Task"\nstate: "Ready" # keep this comment\npinned: false\n---\nBody');

    expect(
      patchTaskFrontmatter("---\ntitle: Old\n...\nBody", {
        title: "New",
        state: "Ready",
        pinned: true,
      }),
    ).toBe('---\ntitle: "New"\nstate: "Ready"\npinned: true\n...\nBody');
    expect(readTaskFrontmatter("---\ntitle: Task\n...\nBody")).toMatchObject({ title: "Task" });
    expect(readTaskFrontmatter("---\rtitle: Task\rstate: Ready\r...\rBody")).toMatchObject({
      title: "Task",
      state: "Ready",
    });
    expect(
      patchTaskFrontmatter("---\rtitle: Old\r...\rBody", {
        title: "New",
        state: "Ready",
        pinned: true,
      }),
    ).toBe('---\rtitle: "New"\rstate: "Ready"\rpinned: true\r...\rBody');
  });

  it("does not append block fields to a flow-style YAML map", () => {
    expect(
      patchTaskFrontmatter('---\n{title: "Old"}\n---\nBody', {
        title: "New",
        state: "Ready",
        pinned: true,
      }),
    ).toBeNull();
  });

  it("leaves malformed or duplicate-key frontmatter unchanged", () => {
    for (const markdown of ["---\ntitle: [broken\n---\nBody", "---\ntitle: a\ntitle: b\n---\nBody"])
      expect(patchTaskFrontmatter(markdown, { title: "Task", state: "", pinned: false })).toBe(
        null,
      );
  });
});
