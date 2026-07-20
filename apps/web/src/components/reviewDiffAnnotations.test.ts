import type { ReviewFinding } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { reviewFindingAnnotation, reviewFindingSelectedLines } from "./reviewDiffAnnotations";

const finding: ReviewFinding = {
  id: "finding-1",
  priority: "high",
  title: "Keep the coordinator durable",
  body: "Route the workflow through the coordinator.",
  confidence: 0.97,
  location: {
    path: "apps/server/src/server.ts",
    side: "new",
    startLine: 148,
    endLine: 150,
  },
};

describe("review diff annotations", () => {
  it("anchors a finding after the final line and selects its full range", () => {
    expect(reviewFindingAnnotation(finding)).toEqual({
      side: "additions",
      lineNumber: 150,
      metadata: finding,
    });
    expect(reviewFindingSelectedLines(finding)).toEqual({
      start: 148,
      end: 150,
      side: "additions",
      endSide: "additions",
    });
  });

  it("maps old-side findings to deletions", () => {
    const oldFinding: ReviewFinding = {
      ...finding,
      location: { ...finding.location, side: "old" },
    };

    expect(reviewFindingAnnotation(oldFinding).side).toBe("deletions");
    expect(reviewFindingSelectedLines(oldFinding).side).toBe("deletions");
  });
});
