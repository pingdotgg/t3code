import { describe, expect, it } from "vitest";

import {
  MessageId,
  TurnId,
  type GitReviewDiffSection,
  type OrchestrationCheckpointSummary,
} from "@t3tools/contracts";

import {
  buildReviewParsedDiff,
  buildReviewSectionItems,
  getDefaultReviewSectionId,
  getReviewSectionIdForCheckpoint,
} from "./reviewModel";

function makeCheckpoint(
  input: Partial<OrchestrationCheckpointSummary> &
    Pick<OrchestrationCheckpointSummary, "turnId" | "checkpointTurnCount" | "completedAt">,
): OrchestrationCheckpointSummary {
  return {
    checkpointRef: `refs/t3/checkpoints/thread/${input.checkpointTurnCount}` as any,
    status: "ready",
    files: [],
    assistantMessageId: MessageId.make(`msg-${input.checkpointTurnCount}`),
    ...input,
  };
}

describe("buildReviewSectionItems", () => {
  it("keeps one chip per checkpoint and appends git sources", () => {
    const checkpoints = [
      makeCheckpoint({
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: 1,
        completedAt: "2026-04-01T00:00:00.000Z",
      }),
      makeCheckpoint({
        turnId: TurnId.make("turn-2"),
        checkpointTurnCount: 2,
        completedAt: "2026-04-02T00:00:00.000Z",
      }),
    ];
    const gitSections: GitReviewDiffSection[] = [
      {
        kind: "dirty",
        title: "Dirty worktree",
        baseRef: "HEAD",
        headRef: null,
        diff: "diff --git a/a.ts b/a.ts",
      },
      {
        kind: "base",
        title: "Against main",
        baseRef: "main",
        headRef: "feature",
        diff: "diff --git a/a.ts b/a.ts",
      },
    ];

    const loadedTurnId = getReviewSectionIdForCheckpoint(checkpoints[0]);
    const items = buildReviewSectionItems({
      checkpoints,
      gitSections,
      turnDiffById: {
        [loadedTurnId]: "diff --git a/loaded.ts b/loaded.ts",
      },
      loadingTurnIds: {
        [getReviewSectionIdForCheckpoint(checkpoints[1])]: true,
      },
    });

    expect(items.map((item) => item.id)).toEqual(["turn:2", "turn:1", "git:dirty", "git:base"]);
    expect(items[0]).toMatchObject({ isLoading: true, diff: null });
    expect(items[1]).toMatchObject({
      isLoading: false,
      diff: expect.stringContaining("loaded.ts"),
    });
    expect(getDefaultReviewSectionId(items)).toBe("turn:2");
  });
});

describe("buildReviewParsedDiff", () => {
  it("builds renderable rows from a unified patch", () => {
    const parsed = buildReviewParsedDiff(
      [
        "diff --git a/apps/mobile/src/a.ts b/apps/mobile/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/apps/mobile/src/a.ts",
        "+++ b/apps/mobile/src/a.ts",
        "@@ -1,2 +1,3 @@",
        "-const before = 1;",
        "+const after = 2;",
        "+console.log(after);",
        " return true;",
      ].join("\n"),
      "unit",
    );

    expect(parsed.kind).toBe("files");
    if (parsed.kind !== "files") {
      return;
    }

    expect(parsed.fileCount).toBe(1);
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(1);
    expect(parsed.files[0]).toMatchObject({
      path: "apps/mobile/src/a.ts",
      additions: 2,
      deletions: 1,
    });
    expect(parsed.files[0]?.rows).toEqual([
      expect.objectContaining({ kind: "hunk", header: "@@ -1,2 +1,3 @@" }),
      expect.objectContaining({
        kind: "line",
        change: "delete",
        oldLineNumber: 1,
        newLineNumber: null,
        content: "const before = 1;",
      }),
      expect.objectContaining({
        kind: "line",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 1,
        content: "const after = 2;",
      }),
      expect.objectContaining({
        kind: "line",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 2,
        content: "console.log(after);",
      }),
      expect.objectContaining({
        kind: "line",
        change: "context",
        oldLineNumber: 2,
        newLineNumber: 3,
        content: "return true;",
      }),
    ]);
  });

  it("treats truncated patches as partial diffs instead of failing", () => {
    const parsed = buildReviewParsedDiff(
      [
        "diff --git a/apps/mobile/src/a.ts b/apps/mobile/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/apps/mobile/src/a.ts",
        "+++ b/apps/mobile/src/a.ts",
        "@@ -1 +1,2 @@",
        " const before = 1;",
        "+const after = 2;",
        "",
        "[truncated]",
      ].join("\n"),
      "unit-truncated",
    );

    expect(parsed.kind).toBe("files");
    if (parsed.kind !== "files") {
      return;
    }

    expect(parsed.notice).toContain("server size cap");
    expect(parsed.fileCount).toBe(1);
    expect(parsed.files[0]?.rows[0]).toMatchObject({
      kind: "hunk",
      header: "@@ -1,1 +1,2 @@",
    });
  });
});
