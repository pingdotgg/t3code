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
});
