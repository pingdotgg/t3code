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

  it("accepts one JSON review object surrounded by provider prose", () => {
    expect(
      parseReviewResult({
        snapshot,
        output: `The change is well-structured and typecheck passes.

${JSON.stringify({
  findings: [],
  overall_correctness: "patch is correct",
  overall_explanation: "No actionable issues found.",
  overall_confidence_score: 0.9,
})}`,
      }),
    ).toMatchObject({
      status: "parsed",
      verdict: "approve",
      summary: "No actionable issues found.",
    });
  });

  it("rejects provider output containing multiple JSON objects", () => {
    const output = JSON.stringify({
      findings: [],
      overall_correctness: "patch is correct",
      overall_explanation: "No actionable issues found.",
      overall_confidence_score: 0.9,
    });
    expect(parseReviewResult({ snapshot, output: `${output}\n${output}` })).toMatchObject({
      status: "invalid-output",
      issues: ["Reviewer output contained multiple JSON objects."],
    });
  });

  it("rejects findings outside the reviewed diff, non-Codex, and non-JSON output", () => {
    expect(
      parseReviewResult({
        snapshot,
        output: JSON.stringify({
          findings: [
            {
              priority: 3,
              title: "[P3] Unreviewed file",
              body: "This is out of scope.",
              confidence_score: 0.5,
              code_location: {
                absolute_file_path: "/workspace/project/src/other.ts",
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
          location: {
            path: "src/example.ts",
            side: "new",
            startLine: 2,
            endLine: 3,
          },
        },
      ],
    });
  });

  it("infers the old side for findings anchored on deleted lines", () => {
    const deletionSnapshot = {
      scope: {
        kind: "uncommitted" as const,
        branch: "main",
        untrackedFiles: [],
      },
      diff: `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -2,3 +2,2 @@
 keep();
-removed();
 tail();
`,
      diffHash: "deletion-hash",
    };
    expect(
      parseReviewResult({
        snapshot: deletionSnapshot,
        output: JSON.stringify({
          findings: [
            {
              title: "[P1] Restore the removed guard",
              body: "Deleting this call drops a required safety check.",
              confidence_score: 0.9,
              priority: 1,
              code_location: {
                absolute_file_path: "/workspace/project/src/example.ts",
                line_range: { start: 3, end: 3 },
              },
            },
          ],
          overall_correctness: "patch is incorrect",
          overall_explanation: "The deletion is unsafe.",
          overall_confidence_score: 0.9,
        }),
      }),
    ).toMatchObject({
      status: "parsed",
      findings: [
        {
          title: "Restore the removed guard",
          location: {
            path: "src/example.ts",
            side: "old",
            startLine: 3,
            endLine: 3,
          },
        },
      ],
    });
  });

  it("keeps findings that cite unchanged lines of a reviewed file", () => {
    const result = parseReviewResult({
      snapshot,
      output: JSON.stringify({
        findings: [
          {
            title: "[P1] Valid comment on the changed line",
            body: "The new call needs validation.",
            confidence_score: 0.9,
            priority: 1,
            code_location: {
              absolute_file_path: "/workspace/project/src/example.ts",
              line_range: { start: 2, end: 2 },
            },
          },
          {
            title: "[P2] Comment on context inside the hunk",
            body: "The surrounding call is affected by the change.",
            confidence_score: 0.6,
            priority: 2,
            code_location: {
              absolute_file_path: "/workspace/project/src/example.ts",
              line_range: { start: 3, end: 3 },
            },
          },
          {
            title: "[P2] Comment beyond the hunk",
            body: "This line is not rendered in the diff.",
            confidence_score: 0.6,
            priority: 2,
            code_location: {
              absolute_file_path: "/workspace/project/src/example.ts",
              line_range: { start: 40, end: 42 },
            },
          },
        ],
        overall_correctness: "patch is incorrect",
        overall_explanation: "Three issues found.",
        overall_confidence_score: 0.9,
      }),
    });
    expect(result).toMatchObject({
      status: "parsed",
      findings: [
        { id: "finding-1", title: "Valid comment on the changed line" },
        {
          id: "finding-2",
          title: "Comment on context inside the hunk",
          location: { side: "new", startLine: 3, endLine: 3 },
        },
        {
          id: "finding-3",
          title: "Comment beyond the hunk",
          location: { side: "new", startLine: 40, endLine: 42 },
        },
      ],
    });
    expect(result.status === "parsed" && result.findings).toHaveLength(3);
  });
  it("keeps findings when optional reviewer fields are missing or malformed", () => {
    expect(
      parseReviewResult({
        snapshot,
        output: JSON.stringify({
          findings: [
            {
              title: "[P0] Missing priority and confidence",
              body: "Derived from the title tag.",
              code_location: {
                absolute_file_path: "example.ts",
                line_range: { start: 3, end: 2 },
              },
            },
            {
              title: "No priority tag",
              body: "Defaults to medium.",
              confidence_score: 4,
              priority: 9,
              code_location: {
                absolute_file_path: "/elsewhere/src/example.ts",
                line_range: { start: 2, end: 2 },
              },
            },
          ],
          overall_correctness: "patch is incorrect",
        }),
      }),
    ).toMatchObject({
      status: "parsed",
      verdict: "request-changes",
      findings: [
        {
          priority: "critical",
          confidence: 0.5,
          location: { path: "src/example.ts", startLine: 2, endLine: 3 },
        },
        { priority: "medium", confidence: 1 },
      ],
    });
  });

  it("drops only the malformed finding", () => {
    const result = parseReviewResult({
      snapshot,
      output: JSON.stringify({
        findings: [
          {
            title: "   ",
            body: "Empty title.",
            priority: 1,
            confidence_score: 0.9,
            code_location: {
              absolute_file_path: "src/example.ts",
              line_range: { start: 2, end: 2 },
            },
          },
          {
            title: "[P1] Valid",
            body: "Real finding.",
            priority: 1,
            confidence_score: 0.9,
            code_location: {
              absolute_file_path: "src/example.ts",
              line_range: { start: 2, end: 2 },
            },
          },
        ],
        overall_correctness: "patch is incorrect",
        overall_explanation: "One issue found.",
      }),
    });
    expect(result.status === "parsed" && result.findings).toHaveLength(1);
    expect(result).toMatchObject({ findings: [{ id: "finding-2", title: "Valid" }] });
  });
});
