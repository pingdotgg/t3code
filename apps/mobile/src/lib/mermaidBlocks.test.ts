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
      ].join("\n"),
    );
    const tail = segments[segments.length - 1];
    expect(tail).toMatchObject({ kind: "markdown" });
    if (tail?.kind === "markdown") {
      expect(tail.markdown).toContain("[guide]: https://example.com");
      expect(tail.markdown).toContain("[Open][guide]");
    }
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
});
