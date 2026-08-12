import { DateTime, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ReviewDiffPreviewInput, ReviewDiffPreviewResult } from "./review.ts";

const decodePreviewInput = Schema.decodeUnknownSync(ReviewDiffPreviewInput);
const decodePreviewResult = Schema.decodeUnknownSync(ReviewDiffPreviewResult);

describe("ReviewDiffPreviewInput", () => {
  it("accepts a request key an older server does not know about", () => {
    // Newer clients send fields older servers never learned; decoding has to keep working
    // there, or every request from an updated client fails against an older server.
    const decoded = decodePreviewInput({ cwd: "/repo", unknownFutureOption: true });

    expect(decoded.cwd).toBe("/repo");
  });
});

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
