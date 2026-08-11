import { DateTime, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ReviewDiffPreviewResult } from "./review.ts";

const decodePreviewResult = Schema.decodeUnknownSync(ReviewDiffPreviewResult);

describe("ReviewDiffPreviewResult", () => {
  it("decodes a response from a server that predates commit previews", () => {
    const decoded = decodePreviewResult({
      cwd: "/repo",
      generatedAt: DateTime.makeUnsafe("2026-08-10T00:00:00.000Z"),
      sources: [],
    });

    expect(decoded.branchCommits).toEqual([]);
    expect(decoded.branchCommitsTruncated).toBe(false);
  });
});
