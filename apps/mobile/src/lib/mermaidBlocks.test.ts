import { describe, expect, it } from "vite-plus/test";

import { splitMarkdownWithMermaid } from "./mermaidBlocks";

describe("splitMarkdownWithMermaid", () => {
  it("returns plain markdown untouched", () => {
    expect(splitMarkdownWithMermaid("# Hi\n\nSome text")).toMatchObject([
      { kind: "markdown", markdown: "# Hi\n\nSome text" },
    ]);
  });

  it("splits a single mermaid block", () => {
    const segments = splitMarkdownWithMermaid(
      ["Before", "", "```mermaid", "flowchart TD", "  A --> B", "```", "", "After"].join("\n"),
    );
    expect(segments.map((segment) => segment.kind)).toEqual(["markdown", "mermaid", "markdown"]);
    expect(segments[1]).toMatchObject({ kind: "mermaid", source: "flowchart TD\n  A --> B" });
  });

  it("leaves unclosed fences as markdown for streaming", () => {
    const markdown = "Before\n\n```mermaid\nflowchart TD\n  A --> B";
    expect(splitMarkdownWithMermaid(markdown)).toMatchObject([{ kind: "markdown", markdown }]);
    const example = "````md\n```mermaid\nflowchart TD\nA --> B\n```";
    expect(splitMarkdownWithMermaid(example)).toMatchObject([
      { kind: "markdown", markdown: example },
    ]);
  });

  it("supports tilde fences and ignores non-mermaid fences", () => {
    const segments = splitMarkdownWithMermaid(
      ["~~~mermaid", "flowchart TD", "  A --> B", "~~~", "", "```ts", "const x = 1;", "```"].join(
        "\n",
      ),
    );
    expect(segments.map((segment) => segment.kind)).toEqual(["mermaid", "markdown"]);
  });

  it("matches mermaid case-insensitively and keeps source stable ids", () => {
    const first = splitMarkdownWithMermaid("```MERMAID\nA --> B\n```");
    const second = splitMarkdownWithMermaid("```mermaid\nA --> B\n```");
    expect(first[0]).toMatchObject({ kind: "mermaid" });
    expect(second[0]).toMatchObject({ kind: "mermaid" });
    if (first[0]?.kind === "mermaid" && second[0]?.kind === "mermaid") {
      expect(first[0].id).toBe(second[0].id);
    }
  });

  it("accepts fences longer than three backticks", () => {
    const segments = splitMarkdownWithMermaid(
      ["````mermaid", "flowchart TD", "  A --> B", "````"].join("\n"),
    );
    expect(segments).toMatchObject([{ kind: "mermaid", source: "flowchart TD\n  A --> B" }]);
  });

  it("keeps a mermaid example inside a non-mermaid fence whole", () => {
    const markdown = ["```md", "```mermaid", "A --> B", "```", "```"].join("\n");
    const segments = splitMarkdownWithMermaid(markdown);
    expect(segments.map((segment) => segment.kind)).toEqual(["markdown"]);
    expect(segments[0]).toMatchObject({ kind: "markdown", markdown });
  });

  it("uses position keys that survive content appends", () => {
    const before = splitMarkdownWithMermaid("```mermaid\nA --> B\n```\n\nHello");
    const after = splitMarkdownWithMermaid("```mermaid\nA --> B\n```\n\nHello world");
    expect(before.map((segment) => segment.key)).toEqual(after.map((segment) => segment.key));
  });

  it("shares link reference definitions with segments after a fence", () => {
    const segments = splitMarkdownWithMermaid(
      [
        "[guide]: https://example.com",
        "",
        "```mermaid",
        "A --> B",
        "```",
        "",
        "[Open][guide]",
        "",
        "```text",
        "[guide]: https://example.com",
        "```",
      ].join("\n"),
    );
    const tail = segments[segments.length - 1];
    expect(tail).toMatchObject({ kind: "markdown" });
    if (tail?.kind === "markdown") {
      expect(tail.markdown).toMatch(/^\[guide\]: https:\/\/example\.com\n/);
      expect(tail.markdown).toContain("[Open][guide]");
    }
    const multiline = splitMarkdownWithMermaid(
      "[guide]:\n  https://example.com\n\n```mermaid\nA --> B\n```\n[Open][guide]",
    );
    expect(multiline.at(-1)).toMatchObject({
      kind: "markdown",
      markdown: "[guide]:\n  https://example.com\n[Open][guide]",
    });
  });

  it("renders a mermaid fence inside a blockquote", () => {
    const segments = splitMarkdownWithMermaid(
      ["> Quoted intro", ">", "> ```mermaid", "> A --> B", "> ```"].join("\n"),
    );
    expect(segments.map((segment) => segment.kind)).toEqual(["markdown", "mermaid"]);
    expect(segments[1]).toMatchObject({ kind: "mermaid", source: "A --> B" });
  });

  it("does not let an unquoted fence close a quoted mermaid block", () => {
    const markdown = ["> ```mermaid", "> A --> B", "Outside", "```ts", "const x = 1;", "```"].join(
      "\n",
    );
    const segments = splitMarkdownWithMermaid(markdown);
    expect(segments.map((segment) => segment.kind)).toEqual(["markdown"]);
    expect(segments[0]).toMatchObject({ kind: "markdown", markdown });
    const separateQuote = "> ```mermaid\n> A --> B\nOutside\n> ```ts\n> const x = 1;\n> ```";
    expect(splitMarkdownWithMermaid(separateQuote)).toMatchObject([
      { kind: "markdown", markdown: separateQuote },
    ]);
  });

  it("ignores link definitions inside fenced code", () => {
    const segments = splitMarkdownWithMermaid(
      [
        "```ts",
        "[guide]: https://example.com",
        "```",
        "",
        "```mermaid",
        "A --> B",
        "```",
        "",
        "[Open][guide]",
      ].join("\n"),
    );
    const tail = segments[segments.length - 1];
    expect(tail).toMatchObject({ kind: "markdown" });
    if (tail?.kind === "markdown") {
      expect(tail.markdown).not.toContain("[guide]: https://example.com");
    }
  });

  it("collects definitions after an unclosed quoted fence", () => {
    const segments = splitMarkdownWithMermaid(
      [
        "> ```ts",
        "> [guide]: https://example.com",
        "",
        "[guide]: https://other.example",
        "",
        "```mermaid",
        "A --> B",
        "```",
        "",
        "[Open][guide]",
      ].join("\n"),
    );
    const tail = segments[segments.length - 1];
    expect(tail).toMatchObject({ kind: "markdown" });
    if (tail?.kind === "markdown") {
      expect(tail.markdown).toContain("[guide]: https://other.example");
      expect(tail.markdown).not.toContain("[guide]: https://example.com");
    }
  });

  it("does not let a deeper quoted fence close an outer example", () => {
    const markdown = ["```md", "> ```mermaid", "> A --> B", "> ```", "extra", "```"].join("\n");
    const segments = splitMarkdownWithMermaid(markdown);
    expect(segments.map((segment) => segment.kind)).toEqual(["markdown"]);
    expect(segments[0]).toMatchObject({ kind: "markdown", markdown });
  });

  it("does not copy a label followed by a heading as a definition", () => {
    const segments = splitMarkdownWithMermaid(
      ["[note]:", "# heading", "", "```mermaid", "A --> B", "```", "", "text"].join("\n"),
    );
    const tail = segments[segments.length - 1];
    expect(tail).toMatchObject({ kind: "markdown" });
    if (tail?.kind === "markdown") {
      expect(tail.markdown).toContain("text");
      expect(tail.markdown).not.toContain("[note]:");
    }
  });

  it("keeps single-line definitions with titles", () => {
    const segments = splitMarkdownWithMermaid(
      ['[a]: /url "title"', "", "```mermaid", "A --> B", "```", "", "[Open][a]"].join("\n"),
    );
    const tail = segments[segments.length - 1];
    expect(tail).toMatchObject({ kind: "markdown" });
    if (tail?.kind === "markdown") {
      expect(tail.markdown).toContain('[a]: /url "title"');
    }
  });
});
