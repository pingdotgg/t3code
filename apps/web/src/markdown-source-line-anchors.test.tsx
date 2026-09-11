import { describe, expect, it } from "vite-plus/test";

import { remarkSourceLineAnchors } from "./markdown-source-line-anchors";

describe("remarkSourceLineAnchors", () => {
  it("marks block nodes with their Markdown source line", () => {
    const heading = {
      type: "heading",
      position: { start: { line: 1 } },
      data: undefined as { hProperties?: Record<string, unknown> } | undefined,
    };
    const paragraph = {
      type: "paragraph",
      position: { start: { line: 3 } },
      data: { hProperties: { className: "lead" } },
    };
    const inlineText = { type: "text", position: { start: { line: 3 } } };
    const tree = { type: "root", children: [heading, paragraph, inlineText] };

    remarkSourceLineAnchors()(tree);

    expect(heading.data).toEqual({ hProperties: { dataSourceLine: 1 } });
    expect(paragraph.data).toEqual({
      hProperties: { className: "lead", dataSourceLine: 3 },
    });
    expect(inlineText).not.toHaveProperty("data");
  });
});
