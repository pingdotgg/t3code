// @vitest-environment jsdom
import { CodeView, type CodeViewDiffItem } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { buildFileDiffEntries, getRenderablePatch } from "./diffRendering";

function parseFiles(
  blocks: ReadonlyArray<readonly [path: string, content: string]>,
  scope = "test",
) {
  const patch = getRenderablePatch(
    blocks
      .map(([path, content]) =>
        [
          `diff --git a/${path} b/${path}`,
          `--- a/${path}`,
          `+++ b/${path}`,
          "@@ -1 +1 @@",
          "-before",
          `+${content}`,
          "",
        ].join("\n"),
      )
      .join(""),
    scope,
  );
  if (patch?.kind !== "files") throw new Error("Expected parsed diff files");
  return patch.files;
}

describe("diff file entries", () => {
  it("loads repeated changes to the same path into CodeView with independent collapse state", () => {
    const path = "apps/artelo/services-status-summary.test.ts";
    const files = parseFiles([
      [path, "first change"],
      [path, "second change"],
      [path, "second change"],
    ]);
    const entries = buildFileDiffEntries(files);
    const items = entries.map(
      ({ fileDiff, fileKey, fileVersion }): CodeViewDiffItem<undefined> => ({
        type: "diff",
        id: fileKey,
        fileDiff,
        version: fileVersion,
      }),
    );
    const viewer = new CodeView();
    try {
      viewer.setItems(items);
      for (const item of items) {
        expect(viewer.getItem(item.id)).toMatchObject({ fileDiff: item.fileDiff });
      }
      expect(new Set(items.map((item) => item.id)).size).toBe(3);

      const collapsed = items.map((item, index) => ({
        ...item,
        collapsed: index === 1,
        version: (item.version ?? 0) + 1,
      }));
      viewer.setItems(collapsed);
      expect(collapsed.map((item) => viewer.getItem(item.id)?.collapsed)).toEqual([
        false,
        true,
        false,
      ]);
    } finally {
      viewer.cleanUp();
    }
  });

  it("keeps repeated identities stable across content updates and unrelated insertions", () => {
    const before = buildFileDiffEntries(
      parseFiles([
        ["same.ts", "first"],
        ["same.ts", "second"],
      ]),
    );
    const after = buildFileDiffEntries(
      parseFiles(
        [
          ["unrelated.ts", "new file"],
          ["same.ts", "first"],
          ["same.ts", "updated second"],
        ],
        "refreshed-patch",
      ),
    ).slice(1);

    expect(after.map((entry) => entry.fileKey)).toEqual(before.map((entry) => entry.fileKey));
    expect(after[0]?.fileVersion).toBe(before[0]?.fileVersion);
    expect(after[1]?.fileVersion).not.toBe(before[1]?.fileVersion);
  });

  it("disambiguates occurrences even when the same metadata object is reused", () => {
    const [file] = parseFiles([["same.ts", "change"]]);
    if (!file) throw new Error("Expected a diff file");
    const entries = buildFileDiffEntries([file, file, file]);
    expect(new Set(entries.map((entry) => entry.fileKey)).size).toBe(3);
    expect(entries.map((entry) => entry.fileDiff)).toEqual([file, file, file]);
    expect(buildFileDiffEntries([file, file, file])).toEqual(entries);
  });
});
