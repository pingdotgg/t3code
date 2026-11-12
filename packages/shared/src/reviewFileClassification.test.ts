import { describe, expect, it } from "vite-plus/test";

import { reviewFileChapters, reviewFileChapterIndex } from "./reviewFileClassification.ts";

const getPath = (file: { path: string }) => file.path;
const implementation = Array.from({ length: 30 }, (_, index) => ({
  path: `src/file-${index}.ts`,
  viewed: index < 15,
}));

describe("review chapter membership and visibility", () => {
  it("keeps 15 of 30 reviewed when only the 15 unviewed files are visible", () => {
    const visible = implementation.filter((file) => !file.viewed);
    const [chapter] = reviewFileChapters(implementation, getPath, visible);

    expect(chapter?.files).toHaveLength(30);
    expect(chapter?.files.filter((file) => file.viewed)).toHaveLength(15);
    expect(chapter?.visibleFiles).toEqual(visible);
    expect(reviewFileChapters(implementation, getPath)[0]?.files).toEqual(chapter?.files);
  });

  it("keeps a fully reviewed chapter reachable when every file in it is hidden", () => {
    const files = [
      { path: "src/app.ts", viewed: true },
      { path: "tests/app.test.ts", viewed: true },
      { path: "pnpm-lock.yaml", viewed: false },
    ];
    const chapters = reviewFileChapters(
      files,
      getPath,
      files.filter((file) => !file.viewed),
    );

    expect(chapters.map((chapter) => chapter.id)).toEqual(["code", "tests", "generated"]);
    expect(chapters[0]?.files).toEqual([files[0]]);
    expect(chapters[0]?.visibleFiles).toEqual([]);
    expect(chapters[1]?.files).toEqual([files[1]]);
    expect(chapters[1]?.visibleFiles).toEqual([]);
    expect(chapters[2]?.visibleFiles).toEqual([files[2]]);
    // Chapter-level unviewing still has every path even though the reader has no rows.
    expect(chapters.flatMap((chapter) => chapter.files.map(getPath))).toEqual(files.map(getPath));
  });

  it("keeps the full membership when other viewing options hide unviewed files too", () => {
    const [chapter] = reviewFileChapters(implementation, getPath, [implementation[20]!]);
    expect(chapter?.files).toHaveLength(30);
    expect(chapter?.files.filter((file) => file.viewed)).toHaveLength(15);
    expect(chapter?.visibleFiles).toEqual([implementation[20]]);
  });

  it("preserves the reader's order independently of the complete chapter inventory", () => {
    const files = [{ path: "src/z.ts" }, { path: "tests/app.test.ts" }, { path: "src/a.ts" }];
    const [chapter] = reviewFileChapters(files, getPath, [files[2]!, files[0]!]);
    expect(chapter?.files).toEqual([files[0], files[2]]);
    expect(chapter?.visibleFiles).toEqual([files[2], files[0]]);
  });

  it("uses the whole chapter by default and omits groups with no changed files", () => {
    const chapters = reviewFileChapters(implementation, getPath);
    expect(chapters.map((chapter) => chapter.id)).toEqual(["code"]);
    expect(chapters[0]?.visibleFiles).toBe(chapters[0]?.files);
    expect(reviewFileChapters([], getPath, [])).toEqual([]);
  });
});

describe("complete review chapter inventory", () => {
  const paths = [
    "src/app.ts",
    "src/app.test.ts",
    "src/app.fixtures.ts",
    "pnpm-lock.yaml",
    "README.md",
    "src/__snapshots__/app.test.ts.snap",
  ];
  it("uses the same five categories as the diff breakdown, including fixtures and snapshots", () => {
    const { chapters } = reviewFileChapterIndex({
      completePaths: paths,
      loadedFiles: [],
      visibleFiles: [],
      getPath: (file: { path: string }) => file.path,
    });
    expect(chapters.map((chapter) => [chapter.title, chapter.files])).toEqual([
      ["Code", [paths[0]]],
      ["Tests", [paths[1]]],
      ["Mocks", [paths[2], paths[5]]],
      ["Generated", [paths[3]]],
      ["Docs", [paths[4]]],
    ]);
  });
  it("keeps all chapter totals and viewed counts fixed as diff pages arrive or filters hide files", () => {
    const completePaths = Array.from({ length: 79 }, (_, index) => `src/file-${index}.ts`);
    const reviewed = new Set(completePaths.slice(60));
    for (const count of [0, 7, 24, 79]) {
      const loadedFiles = completePaths.slice(0, count).map((path) => ({ path, contents: "diff" }));
      const visibleFiles = loadedFiles.filter((file) => !reviewed.has(file.path));
      const result = reviewFileChapterIndex({ completePaths, loadedFiles, visibleFiles, getPath });
      expect(result.complete).toBe(true);
      expect(result.chapters[0]?.files).toHaveLength(79);
      expect(result.chapters[0]?.files.filter((path) => reviewed.has(path))).toHaveLength(19);
      expect(result.chapters[0]?.visibleFiles).toEqual(visibleFiles);
      expect(result.chapters[0]?.visibleFiles[0]).toBe(visibleFiles[0]);
    }
  });
  it("does not claim loaded files are a complete inventory while metadata is pending or truncated", () => {
    const result = reviewFileChapterIndex({
      completePaths: null,
      loadedFiles: [{ path: "src/app.ts" }],
      visibleFiles: [],
      getPath,
    });
    expect(result.complete).toBe(false);
    expect(result.chapters[0]?.files).toEqual(["src/app.ts"]);
  });
});
