import { describe, expect, it } from "@effect/vitest";

import {
  buildApprovedFixPrompt,
  buildReviewDiffContext,
  reviewApprovalSignature,
  safeWorkspaceRelativePath,
  summarizeUnifiedDiff,
  type ReviewFinding,
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
  it("combines diff sources and reports clipping", () => {
    const result = buildReviewDiffContext(
      [
        {
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
      truncated: true,
    });
    expect(result.diff).toContain("[Diff context clipped at 80 characters]");
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

describe("approved fix handoff", () => {
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

  it("uses all finding fields in its approval signature", () => {
    expect(reviewApprovalSignature(findings, ["pnpm test example"])).not.toBe(
      reviewApprovalSignature(
        [{ ...findings[0]!, suggestedFix: "Use a fallback." }],
        ["pnpm test example"],
      ),
    );
  });

  it("includes verification commands in its approval signature", () => {
    expect(reviewApprovalSignature(findings, ["pnpm test example"])).not.toBe(
      reviewApprovalSignature(findings, ["pnpm typecheck"]),
    );
  });

  it("builds a constrained coding-agent prompt", () => {
    const prompt = buildApprovedFixPrompt(findings, ["pnpm test example"]);

    expect(prompt).toContain("Make only the approved changes");
    expect(prompt).toContain("src/example.ts:12");
    expect(prompt).toContain("Return early when the value is missing.");
    expect(prompt).toContain("pnpm test example");
  });
});
