import { describe, expect, it } from "vite-plus/test";

import { reviewFileChapters } from "./reviewFileClassification.ts";

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

    expect(chapters.map((chapter) => chapter.id)).toEqual(["implementation", "tests", "generated"]);
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
    expect(chapters.map((chapter) => chapter.id)).toEqual(["implementation"]);
    expect(chapters[0]?.visibleFiles).toBe(chapters[0]?.files);
    expect(reviewFileChapters([], getPath, [])).toEqual([]);
  });
});
