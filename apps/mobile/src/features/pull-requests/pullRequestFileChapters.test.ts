import { describe, expect, it } from "vite-plus/test";
import { pullRequestFileChapters } from "./pullRequestFileChapters";

describe("mobile PR chapter counts", () => {
  const paths = Array.from({ length: 79 }, (_, index) => `src/file${index}.ts`);
  const viewed = new Set(paths.slice(20, 24));

  it("counts unloaded and reviewed files from the complete index as diff pages arrive", () => {
    for (const loadedCount of [7, 10, 24, 79]) {
      const loadedPaths = paths.slice(0, loadedCount);
      const result = pullRequestFileChapters({
        completePaths: [...paths, "src/example.test.ts", "pnpm-lock.yaml"],
        loadedPaths,
        visiblePaths: loadedPaths,
        hideTestFiles: false,
      });
      expect(result.complete).toBe(true);
      expect(result.chapters.map((chapter) => chapter.title)).toEqual([
        "Implementation",
        "Tests",
        "Generated",
      ]);
      const chapter = result.chapters[0]!;
      expect(chapter.files).toHaveLength(79);
      expect(chapter.files.filter((path) => viewed.has(path))).toHaveLength(4);
      expect(chapter.visibleFiles).toHaveLength(loadedCount);
    }
  });

  it("does not present a partial or truncated index as a complete count", () => {
    const result = pullRequestFileChapters({
      completePaths: null,
      loadedPaths: paths.slice(0, 7),
      visiblePaths: paths.slice(0, 7),
      hideTestFiles: false,
    });
    expect(result.complete).toBe(false);
  });

  it("keeps totals independent of hidden reviewed files and respects the test-file filter", () => {
    const result = pullRequestFileChapters({
      completePaths: [...paths, "src/example.test.ts", "src/selected.test.ts"],
      loadedPaths: [],
      visiblePaths: [],
      hideTestFiles: true,
      includePath: "src/selected.test.ts",
    });
    expect(
      result.chapters.map((chapter) => [
        chapter.id,
        chapter.files.length,
        chapter.visibleFiles.length,
      ]),
    ).toEqual([
      ["implementation", 79, 0],
      ["tests", 1, 0],
    ]);
  });
});
