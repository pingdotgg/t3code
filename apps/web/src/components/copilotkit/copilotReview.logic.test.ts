import { describe, expect, it } from "@effect/vitest";

import {
  buildReviewDiffContext,
  reviewSubmissionProblem,
  safeWorkspaceRelativePath,
  selectCompleteReviewDiffSources,
  summarizeUnifiedDiff,
  upsertReviewProgress,
  type ReviewFinding,
  type ReviewSubmission,
} from "./copilotReview.logic";

const diff = `diff --git a/src/old.ts b/src/new.ts
similarity index 81%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,2 +1,3 @@
-const count = 1;
+const count = 2;
+const enabled = true;
 export { count };
diff --git a/src/added.ts b/src/added.ts
new file mode 100644
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1 @@
+export const added = true;
`;

describe("summarizeUnifiedDiff", () => {
  it("counts changed paths and patch lines", () => {
    expect(summarizeUnifiedDiff(diff)).toEqual([
      { path: "src/new.ts", additions: 2, deletions: 1 },
      { path: "src/added.ts", additions: 1, deletions: 0 },
    ]);
  });
});

describe("buildReviewDiffContext", () => {
  it("keeps the complete diff in ordered chunks", () => {
    const result = buildReviewDiffContext(
      [
        {
          kind: "branch-range",
          title: "Against main",
          baseRef: "main",
          headRef: "feature",
          diff,
          truncated: false,
        },
      ],
      80,
    );

    expect(result.summary).toEqual({
      changedFiles: 2,
      additions: 3,
      deletions: 1,
      sourceCount: 1,
      truncated: false,
    });
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks.map((chunk) => chunk.diff).join("")).toBe(diff);
    expect(result.chunks.map((chunk) => chunk.index)).toEqual(
      result.chunks.map((_, index) => index + 1),
    );
    expect(result.chunks.every((chunk) => chunk.diff.length <= 80)).toBe(true);
    expect(result.chunks.every((chunk) => chunk.files.length > 0)).toBe(true);
    expect(result.chunks.every((chunk) => chunk.characters === chunk.diff.length)).toBe(true);
  });

  it("only reports truncation when the host returned an incomplete source", () => {
    const result = buildReviewDiffContext([
      {
        kind: "branch-range",
        title: "Against main",
        baseRef: "main",
        headRef: "feature",
        diff,
        truncated: true,
      },
    ]);

    expect(result.summary.truncated).toBe(true);
  });

  it("rejects invalid chunk sizes", () => {
    expect(() => buildReviewDiffContext([], 0)).toThrow(
      "Review diff chunk size must be a positive integer.",
    );
  });
});

describe("selectCompleteReviewDiffSources", () => {
  const workingTree = {
    kind: "working-tree" as const,
    title: "Dirty worktree",
    baseRef: "HEAD",
    headRef: null,
    diff,
    truncated: false,
  };
  const truncatedBranch = {
    kind: "branch-range" as const,
    title: "Against main",
    baseRef: "main",
    headRef: "feature",
    diff,
    truncated: true,
  };

  it("reviews complete working changes when the historical branch range is too large", () => {
    expect(selectCompleteReviewDiffSources([workingTree, truncatedBranch])).toEqual({
      sources: [workingTree],
      workingTreeFallback: true,
    });
  });

  it("keeps an incomplete result visible when no complete fallback exists", () => {
    expect(selectCompleteReviewDiffSources([truncatedBranch])).toEqual({
      sources: [truncatedBranch],
      workingTreeFallback: false,
    });
  });
});

describe("safeWorkspaceRelativePath", () => {
  it("accepts a repository-relative path", () => {
    expect(safeWorkspaceRelativePath("b/apps/web/src/main.tsx")).toBe("apps/web/src/main.tsx");
  });

  it.each(["", "/etc/passwd", "../secret", "src/../secret", "C:\\secret.txt"])(
    "rejects unsafe path %s",
    (value) => {
      expect(safeWorkspaceRelativePath(value)).toBeNull();
    },
  );
});

describe("review submission", () => {
  const findings: ReviewFinding[] = [
    {
      id: "finding-1",
      severity: "high",
      title: "Guard missing value",
      file: "src/example.ts",
      line: 12,
      explanation: "The value can be undefined.",
      suggestedFix: "Return early when the value is missing.",
    },
  ];

  const context = buildReviewDiffContext([
    {
      kind: "branch-range",
      title: "Against main",
      baseRef: "main",
      headRef: "feature",
      diff: `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;`,
      truncated: false,
    },
  ]);
  const submission: ReviewSubmission = {
    verdict: "needs-work",
    summary: "One issue found.",
    changedFiles: 1,
    additions: 1,
    deletions: 1,
    findings,
  };

  it("accepts findings that match the inspected diff", () => {
    expect(reviewSubmissionProblem(context, submission)).toBeNull();
  });

  it("rejects model-authored totals that do not match inspection", () => {
    expect(reviewSubmissionProblem(context, { ...submission, additions: 9 })).toBe(
      "Review totals do not match the inspected diff.",
    );
  });

  it("rejects findings for files outside the inspected diff", () => {
    expect(
      reviewSubmissionProblem(context, {
        ...submission,
        findings: [{ ...findings[0]!, file: "src/other.ts" }],
      }),
    ).toContain("does not point to a file in the inspected diff");
  });
});

describe("upsertReviewProgress", () => {
  it("keeps stage order while updating streamed progress", () => {
    const mapping = {
      stage: "mapping" as const,
      title: "Mapping changes",
      detail: "Reading two files",
      files: ["src/a.ts"],
    };
    const correctness = {
      stage: "correctness" as const,
      title: "Checking behavior",
      detail: "Tracing the changed branch",
      files: ["src/b.ts"],
    };

    expect(
      upsertReviewProgress([mapping, correctness], {
        ...mapping,
        detail: "Reading three files",
      }),
    ).toEqual([{ ...mapping, detail: "Reading three files" }, correctness]);
  });
});
