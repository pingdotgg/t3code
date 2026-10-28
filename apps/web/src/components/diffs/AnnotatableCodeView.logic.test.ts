import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import { buildFileDiffContentVersion, buildFileDiffIdentityKey } from "~/lib/diffRendering";

import { isDiffCommentAnchorCurrent } from "./AnnotatableCodeView.logic";

function file(contents: string) {
  return parsePatchFiles(
    `diff --git a/shared.ts b/shared.ts\n--- a/shared.ts\n+++ b/shared.ts\n@@ -1 +1 @@\n-old\n+${contents}\n`,
  )[0]!.files[0]!;
}

describe("diff comment anchors", () => {
  it("invalidates old line coordinates when the same file changes", () => {
    const original = file("new");
    const refreshed = file("newer");
    const anchor = {
      fileKey: buildFileDiffIdentityKey(original),
      filePath: "shared.ts",
      previousFilePath: "shared.ts",
      fileVersion: buildFileDiffContentVersion(original),
    };
    expect(buildFileDiffIdentityKey(refreshed)).toBe(anchor.fileKey);
    const changedFiles = new Map([
      [
        anchor.fileKey,
        { fileVersion: buildFileDiffContentVersion(refreshed), fileDiff: refreshed },
      ],
    ]);
    expect(isDiffCommentAnchorCurrent(anchor, changedFiles, [])).toBe(false);
    expect(
      isDiffCommentAnchorCurrent(
        anchor,
        new Map([[anchor.fileKey, { ...anchor, fileDiff: original }]]),
        [],
      ),
    ).toBe(true);
    const pending = { ...original, type: "rename-changed" as const, hunks: [] };
    expect(isDiffCommentAnchorCurrent(anchor, new Map(), [pending])).toBe(true);
    expect(isDiffCommentAnchorCurrent(anchor, changedFiles, [pending])).toBe(false);
    const sameIdentityPending = { ...original, hunks: [], cacheKey: "shared:pending" };
    expect(
      isDiffCommentAnchorCurrent(
        anchor,
        new Map([
          [
            anchor.fileKey,
            {
              fileDiff: sameIdentityPending,
              fileVersion: buildFileDiffContentVersion(sameIdentityPending),
            },
          ],
        ]),
        [sameIdentityPending],
      ),
    ).toBe(true);
    expect(
      isDiffCommentAnchorCurrent(anchor, new Map(), [{ ...pending, prevName: "other.ts" }]),
    ).toBe(false);
    expect(isDiffCommentAnchorCurrent(anchor, new Map(), [])).toBe(false);
  });
});
