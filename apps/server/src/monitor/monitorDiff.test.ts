import { assert, describe, it } from "@effect/vitest";

import type { PullRequestMonitorSnapshot } from "../sourceControl/gitHubPullRequestMonitor.ts";
import { cursorFromSnapshot, diffPullRequestMonitorSnapshot } from "./monitorDiff.ts";

const snapshot = (
  overrides: Partial<PullRequestMonitorSnapshot> = {},
): PullRequestMonitorSnapshot => ({
  state: "open",
  draft: false,
  headSha: "head-1",
  baseRefName: "main",
  mergeability: "mergeable",
  behindBaseBy: null,
  requiredChecksKnown: true,
  reviews: [],
  reviewThreads: [],
  issueComments: [],
  checkRuns: [],
  ...overrides,
});

const thread = (updatedAt = "2026-01-01T00:00:00Z", resolved = false) => ({
  id: "thread-1",
  author: { login: "review-bot", type: "app" as const },
  latestCommentByViewer: false,
  body: "Fix this",
  path: "src/a.ts",
  line: 3,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt,
  resolved,
});

const check = (id: string, conclusion: "success" | "failure") => ({
  id,
  name: "CI",
  status: "completed" as const,
  conclusion,
  startedAt: "2026-01-01T00:00:00Z",
  headSha: "head-1",
});

describe("pull request monitor diff", () => {
  it("baselines every existing event", () => {
    const initial = snapshot({
      reviewThreads: [thread()],
      checkRuns: [check("run-1", "failure")],
    });
    assert.deepStrictEqual(
      diffPullRequestMonitorSnapshot(cursorFromSnapshot(initial), initial).actionableEvents,
      [],
    );
  });

  it("detects a new comment and an edit by id plus updatedAt", () => {
    const emptyCursor = cursorFromSnapshot(snapshot());
    const withComment = snapshot({ reviewThreads: [thread()] });
    const added = diffPullRequestMonitorSnapshot(emptyCursor, withComment);
    assert.deepStrictEqual(added.actionableEvents, [
      { kind: "new-review-comment", threadId: "thread-1", edited: false },
    ]);

    const edited = diffPullRequestMonitorSnapshot(
      added.nextCursor,
      snapshot({ reviewThreads: [thread("2026-01-02T00:00:00Z")] }),
    );
    assert.deepStrictEqual(edited.actionableEvents, [
      { kind: "new-review-comment", threadId: "thread-1", edited: true },
    ]);
  });

  it("does not wake for the viewer's reply, then wakes for a subsequent reviewer comment", () => {
    const initial = snapshot({ reviewThreads: [thread()] });
    const selfReply = snapshot({
      reviewThreads: [
        {
          ...thread("2026-01-02T00:00:00Z"),
          author: { login: "claude", type: "user" as const },
          latestCommentByViewer: true,
        },
      ],
    });
    const ignored = diffPullRequestMonitorSnapshot(cursorFromSnapshot(initial), selfReply);
    assert.deepStrictEqual(ignored.actionableEvents, []);

    const reviewerReply = snapshot({
      reviewThreads: [thread("2026-01-03T00:00:00Z")],
    });
    assert.deepStrictEqual(
      diffPullRequestMonitorSnapshot(ignored.nextCursor, reviewerReply).actionableEvents,
      [{ kind: "new-review-comment", threadId: "thread-1", edited: true }],
    );
  });

  it("detects new and edited bot issue comments", () => {
    const issueComment = {
      id: "comment-1",
      author: { login: "review-bot", type: "app" as const },
      body: "Please update this",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const added = diffPullRequestMonitorSnapshot(
      cursorFromSnapshot(snapshot()),
      snapshot({ issueComments: [issueComment] }),
    );
    assert.deepStrictEqual(added.actionableEvents, [
      { kind: "new-review-comment", threadId: "comment-1", edited: false },
    ]);
    const edited = diffPullRequestMonitorSnapshot(
      added.nextCursor,
      snapshot({
        issueComments: [{ ...issueComment, updatedAt: "2026-01-02T00:00:00Z" }],
      }),
    );
    assert.deepStrictEqual(edited.actionableEvents, [
      { kind: "new-review-comment", threadId: "comment-1", edited: true },
    ]);
  });

  it("records a resolved transition without waking", () => {
    const initial = snapshot({ reviewThreads: [thread()] });
    const result = diffPullRequestMonitorSnapshot(
      cursorFromSnapshot(initial),
      snapshot({ reviewThreads: [thread("2026-01-02T00:00:00Z", true)] }),
    );
    assert.deepStrictEqual(result.actionableEvents, []);
    assert.strictEqual(result.nextCursor.threadVersions["thread-1"]?.resolved, true);
  });

  it("wakes when a resolved thread is reopened without an updatedAt change", () => {
    const initial = snapshot({ reviewThreads: [thread(undefined, true)] });
    const result = diffPullRequestMonitorSnapshot(
      cursorFromSnapshot(initial),
      snapshot({ reviewThreads: [thread()] }),
    );
    assert.deepStrictEqual(result.actionableEvents, [
      { kind: "new-review-comment", threadId: "thread-1", edited: true },
    ]);
  });

  it("wakes for a failed rerun with a new run id", () => {
    const initial = snapshot({ checkRuns: [check("run-1", "failure")] });
    const result = diffPullRequestMonitorSnapshot(
      cursorFromSnapshot(initial),
      snapshot({ checkRuns: [check("run-2", "failure")] }),
    );
    assert.deepStrictEqual(result.actionableEvents, [
      { kind: "check-failed", checkRunId: "run-2", checkName: "CI" },
    ]);
  });

  it("wakes for a new failure after a seen success", () => {
    const initial = snapshot({ checkRuns: [check("run-1", "success")] });
    const result = diffPullRequestMonitorSnapshot(
      cursorFromSnapshot(initial),
      snapshot({ checkRuns: [check("run-2", "failure")] }),
    );
    assert.deepStrictEqual(result.actionableEvents, [
      { kind: "check-failed", checkRunId: "run-2", checkName: "CI" },
    ]);
  });

  it("wakes for a same-name failure on a new head", () => {
    const initial = snapshot({ checkRuns: [check("run-1", "failure")] });
    const nextCheck = { ...check("run-2", "failure"), headSha: "head-2" };
    const result = diffPullRequestMonitorSnapshot(
      cursorFromSnapshot(initial),
      snapshot({ headSha: "head-2", checkRuns: [nextCheck] }),
    );
    assert.deepStrictEqual(result.actionableEvents, [
      { kind: "check-failed", checkRunId: "run-2", checkName: "CI" },
    ]);
  });

  it("tracks concurrent same-name runs independently", () => {
    const initial = snapshot({ checkRuns: [check("run-1", "success")] });
    const result = diffPullRequestMonitorSnapshot(
      cursorFromSnapshot(initial),
      snapshot({ checkRuns: [check("run-1", "success"), check("run-2", "failure")] }),
    );
    assert.deepStrictEqual(result.actionableEvents, [
      { kind: "check-failed", checkRunId: "run-2", checkName: "CI" },
    ]);
  });
});
