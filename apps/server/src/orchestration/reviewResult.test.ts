import { describe, expect, it } from "vitest";

import { parseReviewResult } from "./reviewResult.ts";

const snapshot = {
  scope: { kind: "uncommitted" as const, branch: "main", untrackedFiles: [] },
  diff: `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -2,2 +2,2 @@
-oldValue();
+newValue();
 context();
`,
  diffHash: "snapshot-hash",
};

describe("parseReviewResult", () => {
  it("accepts Codex findings on changed lines", () => {
    expect(
      parseReviewResult({
        snapshot,
        output: JSON.stringify({
          findings: [
            {
              priority: 1,
              title: "[P1] New behavior is unsafe",
              body: "The new call needs validation.",
              confidence_score: 0.9,
              code_location: {
                absolute_file_path: "/workspace/project/src/example.ts",
                line_range: { start: 2, end: 2 },
              },
            },
          ],
          overall_correctness: "patch is incorrect",
          overall_explanation: "One issue found.",
          overall_confidence_score: 0.9,
        }),
      }),
    ).toMatchObject({
      status: "parsed",
      findings: [{ id: "finding-1" }],
      verdict: "request-changes",
    });
  });

  it("rejects findings outside changed lines, non-Codex, and non-JSON output", () => {
    expect(
      parseReviewResult({
        snapshot,
        output: JSON.stringify({
          findings: [
            {
              priority: 3,
              title: "[P3] Unchanged line",
              body: "This is out of scope.",
              confidence_score: 0.5,
              code_location: {
                absolute_file_path: "/workspace/project/src/example.ts",
                line_range: { start: 3, end: 3 },
              },
            },
          ],
          overall_correctness: "patch is incorrect",
          overall_explanation: "One issue found.",
          overall_confidence_score: 0.5,
        }),
      }),
    ).toMatchObject({ status: "invalid-output" });
    expect(
      parseReviewResult({
        snapshot,
        output: JSON.stringify({
          findings: [],
          verdict: "approve",
          summary: "Legacy output.",
        }),
      }),
    ).toMatchObject({ status: "invalid-output" });
    expect(parseReviewResult({ snapshot, output: "not json" })).toMatchObject({
      status: "invalid-output",
    });
  });

  it("normalizes Codex review output and accepts ranges that overlap a changed line", () => {
    expect(
      parseReviewResult({
        snapshot,
        output: JSON.stringify({
          findings: [
            {
              title: "[P1] Validate the new call",
              body: "When untrusted values reach this call, validation is required.",
              confidence_score: 0.94,
              priority: 1,
              code_location: {
                absolute_file_path: "/workspace/project/src/example.ts",
                line_range: { start: 2, end: 3 },
              },
            },
          ],
          overall_correctness: "patch is incorrect",
          overall_explanation: "The changed call is unsafe.",
          overall_confidence_score: 0.9,
        }),
      }),
    ).toMatchObject({
      status: "parsed",
      verdict: "request-changes",
      summary: "The changed call is unsafe.",
      findings: [
        {
          priority: "high",
          title: "Validate the new call",
          location: { path: "src/example.ts", side: "new", startLine: 2, endLine: 3 },
        },
      ],
    });
  });
});
