import { describe, expect, it } from "vite-plus/test";

import { highlightSourceFile } from "./shikiReviewHighlighter";

describe("highlightSourceFile", () => {
  it("preserves one highlighted token row per source line without trailing newlines", async () => {
    const lines = [
      'const items = ["a"];',
      'expect(items).toEqual(["a"]);',
      "const next = items.map((item) => item.toUpperCase());",
      'expect(next).toContain("A");',
    ];

    const highlighted = await highlightSourceFile({
      path: "apps/mobile/src/example.ts",
      contents: lines.join("\n"),
      theme: "light",
    });

    expect(highlighted.map((tokens) => tokens.map((token) => token.content).join(""))).toEqual(
      lines,
    );
  });

  it("keeps colors for a block comment that spans highlight batches", async () => {
    const body = Array.from({ length: 400 }, (_, index) => `const insideComment${index} = 1;`);
    const highlighted = await highlightSourceFile({
      path: "example.ts",
      contents: ["/*", ...body, "*/", "const after = 2;"].join("\n"),
      theme: "dark",
    });

    const commentColors = new Set(
      highlighted.slice(1, -2).flatMap((line) => line.map((token) => token.color)),
    );
    expect(commentColors.size).toBe(1);
    expect(highlighted.at(-1)?.map((token) => token.color)).not.toEqual(
      highlighted[1]?.map((token) => token.color),
    );
  });
});
