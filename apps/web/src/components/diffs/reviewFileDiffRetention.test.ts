import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  isPendingReviewFile,
  retainLoadedReviewFiles,
  retainedReviewFile,
  reviewDiffViewerKey,
  reviewPatchIndicesForFamily,
  reviewSnapshotFamily,
  reviewSnapshotScope,
} from "./reviewFileDiffRetention";

const identity = {
  environmentId: "env-1",
  cwd: "/repo",
  kind: "working-tree",
  baseRef: "HEAD",
  ignoreWhitespace: false,
};

function file(name: string, cacheKey?: string): FileDiffMetadata {
  return { name, ...(cacheKey ? { cacheKey } : {}) } as FileDiffMetadata;
}

describe("review snapshot identity", () => {
  it("keeps the same review across git snapshots", () => {
    const family = reviewSnapshotFamily(identity);
    expect(reviewSnapshotFamily(identity)).toBe(family);
    expect(reviewSnapshotScope(family, "hash-a")).not.toBe(reviewSnapshotScope(family, "hash-b"));
    expect(reviewDiffViewerKey("section", family)).toBe(`section:${family}`);
    expect(reviewDiffViewerKey("section", null)).toBe("section:preview");
  });

  it("keeps loaded file indexes when the snapshot family is unchanged", () => {
    const family = reviewSnapshotFamily(identity);
    expect(reviewPatchIndicesForFamily({ family, indices: [0, 1, 2, 3, 8] }, family)).toEqual([
      0, 1, 2, 3, 8,
    ]);
    expect(
      reviewPatchIndicesForFamily({ family, indices: [0, 1, 2, 3, 8] }, `${family}:other`),
    ).toEqual([0, 1, 2, 3]);
  });
});

describe("retained review files", () => {
  const loaded = file("src/app.ts", "hash:src/app.ts");
  const placeholder = file("src/app.ts", "next:src/app.ts:pending");

  it("keeps the open file until the next patch arrives", () => {
    expect(
      retainedReviewFile({
        loaded: null,
        previous: loaded,
        placeholder,
        sameFamily: true,
        pending: true,
      }),
    ).toBe(loaded);
  });

  it("drops the open file once its replacement fails or no longer includes it", () => {
    expect(
      retainedReviewFile({
        loaded: null,
        previous: loaded,
        placeholder,
        sameFamily: true,
        pending: false,
      }),
    ).toBe(placeholder);
  });

  it("uses the newly loaded patch", () => {
    const next = file("src/app.ts", "hash-b:src/app.ts");
    expect(
      retainedReviewFile({
        loaded: next,
        previous: loaded,
        placeholder,
        sameFamily: true,
        pending: false,
      }),
    ).toBe(next);
  });

  it("does not carry a file into a different review", () => {
    expect(
      retainedReviewFile({
        loaded: null,
        previous: loaded,
        placeholder,
        sameFamily: false,
        pending: true,
      }),
    ).toBe(placeholder);
    expect(isPendingReviewFile(placeholder)).toBe(true);
  });

  it("stores loaded files and ignores placeholders", () => {
    const previous = new Map([["src/app.ts", loaded]]);
    expect(retainLoadedReviewFiles(previous, [loaded, placeholder], (entry) => entry.name)).toBe(
      previous,
    );
    const next = file("src/app.ts", "hash-b:src/app.ts");
    const retained = retainLoadedReviewFiles(previous, [next], (entry) => entry.name);
    expect(retained.get("src/app.ts")).toBe(next);
  });
});
