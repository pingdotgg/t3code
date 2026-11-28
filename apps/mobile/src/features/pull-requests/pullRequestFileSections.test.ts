import { describe, expect, it } from "vite-plus/test";
import { buildReviewParsedDiff } from "../review/reviewModel";
import { groupByDirectory } from "./pullRequestFileSections";

function patch(path: string) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
}

describe("groupByDirectory", () => {
  it("keeps review order when a parent directory resumes after a subdirectory", () => {
    const parsed = buildReviewParsedDiff(
      ["src/a.ts", "src/lib/b.ts", "src/z.ts"].map(patch).join("\n"),
      "pr",
    );
    if (parsed.kind !== "files") throw new Error("Expected files");
    const items = groupByDirectory(parsed.files, new Set());
    expect(
      items.map((item) => (item.kind === "directory" ? `${item.directory}/` : item.file.path)),
    ).toEqual(["src/", "src/a.ts", "src/lib/", "src/lib/b.ts", "src/", "src/z.ts"]);
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  });
});
