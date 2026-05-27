import { describe, expect, it } from "vitest";
import type { DiffFile, DiffMetadata, DiffSnapshot } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { applyDiffFileDelta, buildPatchCacheKey } from "./diffRendering";

describe("buildPatchCacheKey", () => {
  it("returns a stable cache key for identical content", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch)).toBe(buildPatchCacheKey(patch));
  });

  const baseMetadata: DiffMetadata = {
    filesChanged: 1,
    totalAdditions: 1,
    totalDeletions: 0,
    largeFiles: 0,
    unrenderableFiles: 0,
  };

  function makeDiffFile(path: string, additions = 1): DiffFile {
    return {
      path,
      previousPath: null,
      status: "unknown",
      additions,
      deletions: 0,
      hunks: [],
      isBinary: false,
      size: "normal",
      hasHiddenBidiChars: false,
    };
  }

  function makeSnapshot(): DiffSnapshot {
    return {
      threadId: ThreadId.make("thread-1"),
      fromTurnCount: 0,
      toTurnCount: 1,
      scope: "turn",
      patch: "raw patch",
      metadata: baseMetadata,
      files: [makeDiffFile("src/a.ts")],
    };
  }

  describe("applyDiffFileDelta", () => {
    it("updates one matching file and metadata without changing patch text", () => {
      const snapshot = makeSnapshot();
      const metadata: DiffMetadata = {
        filesChanged: 1,
        totalAdditions: 3,
        totalDeletions: 0,
        largeFiles: 0,
        unrenderableFiles: 0,
      };

      const next = applyDiffFileDelta(snapshot, {
        threadId: snapshot.threadId,
        fromTurnCount: snapshot.fromTurnCount,
        toTurnCount: snapshot.toTurnCount,
        scope: snapshot.scope,
        path: "src/a.ts",
        file: makeDiffFile("src/a.ts", 3),
        metadata,
      });

      expect(next.patch).toBe(snapshot.patch);
      expect(next.metadata).toBe(metadata);
      expect(next.files).toEqual([makeDiffFile("src/a.ts", 3)]);
    });

    it("removes a file when delta file is null", () => {
      const snapshot = makeSnapshot();
      const metadata: DiffMetadata = {
        filesChanged: 0,
        totalAdditions: 0,
        totalDeletions: 0,
        largeFiles: 0,
        unrenderableFiles: 0,
      };

      const next = applyDiffFileDelta(snapshot, {
        threadId: snapshot.threadId,
        fromTurnCount: snapshot.fromTurnCount,
        toTurnCount: snapshot.toTurnCount,
        scope: snapshot.scope,
        path: "src/a.ts",
        file: null,
        metadata,
      });

      expect(next.files).toEqual([]);
      expect(next.metadata).toBe(metadata);
    });

    it("ignores deltas for a different selection", () => {
      const snapshot = makeSnapshot();
      const next = applyDiffFileDelta(snapshot, {
        threadId: snapshot.threadId,
        fromTurnCount: 1,
        toTurnCount: 2,
        scope: snapshot.scope,
        path: "src/a.ts",
        file: makeDiffFile("src/a.ts", 3),
        metadata: baseMetadata,
      });

      expect(next).toBe(snapshot);
    });
  });

  it("normalizes outer whitespace before hashing", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(`\n${patch}\n`)).toBe(buildPatchCacheKey(patch));
  });

  it("changes when diff content changes", () => {
    const before = "diff --git a/a.ts b/a.ts\n+console.log('hello')";
    const after = "diff --git a/a.ts b/a.ts\n+console.log('hello world')";

    expect(buildPatchCacheKey(before)).not.toBe(buildPatchCacheKey(after));
  });

  it("changes when cache scope changes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch, "diff-panel:light")).not.toBe(
      buildPatchCacheKey(patch, "diff-panel:dark"),
    );
  });
});
