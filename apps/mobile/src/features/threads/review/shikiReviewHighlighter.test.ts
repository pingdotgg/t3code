import { describe, expect, it } from "vitest";

import type { ReviewRenderableFile } from "./reviewModel";
import { highlightReviewFile } from "./shikiReviewHighlighter";

function makeRenderableFile(
  input: Partial<ReviewRenderableFile> & Pick<ReviewRenderableFile, "path">,
): ReviewRenderableFile {
  return {
    id: input.path,
    cacheKey: input.path,
    previousPath: null,
    changeType: "new",
    additions: 0,
    deletions: 0,
    languageHint: null,
    additionLines: [],
    deletionLines: [],
    rows: [],
    ...input,
  };
}

describe("highlightReviewFile", () => {
  it("preserves one highlighted token row per diff line even without trailing newlines", async () => {
    const file = makeRenderableFile({
      path: "apps/mobile/src/example.test.ts",
      additionLines: [
        'const items = ["a"];',
        'expect(items).toEqual(["a"]);',
        "const next = items.map((item) => item.toUpperCase());",
        'expect(next).toContain("A");',
      ],
    });

    const highlighted = await highlightReviewFile(file, "light");

    expect(highlighted.additionLines).toHaveLength(file.additionLines.length);
    expect(highlighted.additionLines[0]?.some((token) => token.content === "const")).toBe(true);
    expect(highlighted.additionLines[1]?.some((token) => token.content === "expect")).toBe(true);
    expect(highlighted.additionLines[2]?.some((token) => token.content === "const")).toBe(true);
    expect(highlighted.additionLines[3]?.some((token) => token.content === "expect")).toBe(true);
  });
});
