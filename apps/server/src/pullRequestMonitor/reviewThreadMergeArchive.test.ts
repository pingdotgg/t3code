import type { OrchestrationReadModel, OrchestrationThread, ProjectId } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  canAutoArchiveThreadNow,
  liveReviewThreadPullRequests,
  planReviewThreadAutoArchive,
  reviewThreadMergeArchiveCommandId,
  type ReviewThreadPullRequest,
} from "./reviewThreadMergeArchive.ts";

const REPO = "owner/name";
const projectId = (id: string) => id as ProjectId;

const reviewThread = (
  overrides: {
    readonly id: string;
  } & Record<string, unknown>,
): OrchestrationThread =>
  ({
    projectId: projectId("project-1"),
    title: overrides.id,
    parentThreadId: null,
    reviewSnapshot: { scope: "pull-request" },
    reviewResult: null,
    pullRequests: [
      {
        pullRequest: {
          url: `https://github.com/${REPO}/pull/7`,
          number: 7,
          title: "Add thing",
          state: "open",
          baseBranch: "main",
          headBranch: "feature",
        },
        source: "agent",
        linkedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    pullRequest: null,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    ...overrides,
  }) as unknown as OrchestrationThread;

const readModel = (threads: ReadonlyArray<OrchestrationThread>): OrchestrationReadModel =>
  ({ projects: [], threads, workflowRuns: [] }) as unknown as OrchestrationReadModel;

const mergedPullRequest7 = new Set([`github.com/${REPO}#7`]);

describe("planReviewThreadAutoArchive", () => {
  it("archives a review thread once its pull request is merged", () => {
    const threads = [reviewThread({ id: "root" })];
    expect(planReviewThreadAutoArchive(readModel(threads), mergedPullRequest7)).toEqual([
      { threadId: "root", pullRequestKey: `github.com/${REPO}#7` },
    ]);
  });

  it("leaves a review thread alone while its pull request is open", () => {
    const threads = [reviewThread({ id: "root" })];
    expect(planReviewThreadAutoArchive(readModel(threads), new Set())).toEqual([]);
  });

  it("leaves a non-review thread with a merged pull request alone", () => {
    const threads = [reviewThread({ id: "root", reviewSnapshot: null })];
    expect(planReviewThreadAutoArchive(readModel(threads), mergedPullRequest7)).toEqual([]);
  });

  it("treats a review thread with a recorded result as no longer a review thread", () => {
    const threads = [
      reviewThread({
        id: "root",
        reviewResult: { verdict: "approved" } as unknown as OrchestrationThread["reviewResult"],
      }),
    ];
    expect(planReviewThreadAutoArchive(readModel(threads), mergedPullRequest7)).toEqual([]);
  });

  it("skips already archived and deleted review threads", () => {
    const threads = [
      reviewThread({ id: "archived", archivedAt: "2026-01-02T00:00:00.000Z" }),
      reviewThread({ id: "deleted", deletedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    expect(planReviewThreadAutoArchive(readModel(threads), mergedPullRequest7)).toEqual([]);
  });

  it("skips a review thread with a turn still running", () => {
    const threads = [
      reviewThread({
        id: "running",
        latestTurn: { turnId: "turn-1", state: "running", completedAt: null },
      }),
      reviewThread({
        id: "done",
        latestTurn: {
          turnId: "turn-2",
          state: "completed",
          completedAt: "2026-01-02T00:00:00.000Z",
        },
      }),
    ];
    expect(
      planReviewThreadAutoArchive(readModel(threads), mergedPullRequest7).map(
        (candidate) => candidate.threadId,
      ),
    ).toEqual(["done"]);
  });

  it("defers a review thread whose delegated child is still running", () => {
    const threads = [
      reviewThread({
        id: "root",
        latestTurn: { turnId: "t1", state: "completed", completedAt: "2026-01-02T00:00:00.000Z" },
      }),
      reviewThread({
        id: "child",
        parentThreadId: "root",
        reviewSnapshot: null,
        latestTurn: { turnId: "t2", state: "running", completedAt: null },
      }),
    ];
    expect(planReviewThreadAutoArchive(readModel(threads), mergedPullRequest7)).toEqual([]);
  });

  it("defers a review thread whose grandchild is still running", () => {
    const threads = [
      reviewThread({ id: "root" }),
      reviewThread({ id: "child", parentThreadId: "root", reviewSnapshot: null }),
      reviewThread({
        id: "grandchild",
        parentThreadId: "child",
        reviewSnapshot: null,
        latestTurn: { turnId: "t3", state: "running", completedAt: null },
      }),
    ];
    expect(planReviewThreadAutoArchive(readModel(threads), mergedPullRequest7)).toEqual([]);
  });

  it("still archives once the delegated child finishes", () => {
    const threads = [
      reviewThread({ id: "root" }),
      reviewThread({
        id: "child",
        parentThreadId: "root",
        reviewSnapshot: null,
        latestTurn: { turnId: "t2", state: "completed", completedAt: "2026-01-02T00:00:00.000Z" },
      }),
    ];
    expect(planReviewThreadAutoArchive(readModel(threads), mergedPullRequest7)).toEqual([
      { threadId: "root", pullRequestKey: `github.com/${REPO}#7` },
    ]);
  });

  it("ignores a running delegated child that is already archived", () => {
    const threads = [
      reviewThread({ id: "root" }),
      reviewThread({
        id: "child",
        parentThreadId: "root",
        reviewSnapshot: null,
        archivedAt: "2026-01-02T00:00:00.000Z",
        latestTurn: { turnId: "t2", state: "running", completedAt: null },
      }),
    ];
    expect(planReviewThreadAutoArchive(readModel(threads), mergedPullRequest7)).toEqual([
      { threadId: "root", pullRequestKey: `github.com/${REPO}#7` },
    ]);
  });

  it("skips a review thread the user settled", () => {
    const threads = [reviewThread({ id: "root", settledOverride: "settled" })];
    expect(planReviewThreadAutoArchive(readModel(threads), mergedPullRequest7)).toEqual([]);
  });

  it("archives a pinned review thread, whose children the archive command carries with it", () => {
    const threads = [
      reviewThread({ id: "root", pinnedAt: "2026-01-02T00:00:00.000Z" }),
      reviewThread({ id: "child", parentThreadId: "root", reviewSnapshot: null }),
    ];
    expect(planReviewThreadAutoArchive(readModel(threads), mergedPullRequest7)).toEqual([
      { threadId: "root", pullRequestKey: `github.com/${REPO}#7` },
    ]);
  });

  it("leaves out a nested review thread the same sweep already archives through its parent", () => {
    const threads = [
      reviewThread({ id: "root" }),
      reviewThread({ id: "nested", parentThreadId: "root" }),
    ];
    expect(planReviewThreadAutoArchive(readModel(threads), mergedPullRequest7)).toEqual([
      { threadId: "root", pullRequestKey: `github.com/${REPO}#7` },
    ]);
  });

  it("leaves out a nested review thread listed before the parent that archives it", () => {
    const threads = [
      reviewThread({ id: "nested", parentThreadId: "root" }),
      reviewThread({ id: "root" }),
    ];
    expect(
      planReviewThreadAutoArchive(readModel(threads), mergedPullRequest7).map(
        (candidate) => candidate.threadId,
      ),
    ).toEqual(["root"]);
  });

  it("leaves out a review thread nested two levels under a candidate ancestor", () => {
    const threads = [
      reviewThread({ id: "deep", parentThreadId: "middle" }),
      reviewThread({ id: "middle", parentThreadId: "root" }),
      reviewThread({ id: "root" }),
    ];
    expect(
      planReviewThreadAutoArchive(readModel(threads), mergedPullRequest7).map(
        (candidate) => candidate.threadId,
      ),
    ).toEqual(["root"]);
  });

  it("archives each unrelated merged review thread once", () => {
    const threads = [
      reviewThread({ id: "root-a" }),
      reviewThread({ id: "child", parentThreadId: "root-a", reviewSnapshot: null }),
      reviewThread({ id: "root-b" }),
    ];
    expect(
      planReviewThreadAutoArchive(readModel(threads), mergedPullRequest7).map(
        (candidate) => candidate.threadId,
      ),
    ).toEqual(["root-a", "root-b"]);
  });

  it("reads the legacy single pull request projection", () => {
    const threads = [
      reviewThread({
        id: "root",
        pullRequests: [],
        pullRequest: {
          url: `https://github.com/${REPO}/pull/7`,
          number: 7,
          title: "Add thing",
          state: "open",
          baseBranch: "main",
          headBranch: "feature",
        },
      }),
    ];
    expect(planReviewThreadAutoArchive(readModel(threads), mergedPullRequest7)).toHaveLength(1);
  });

  it("uses the thread's own merged pull request when it links more than one", () => {
    const threads = [
      reviewThread({
        id: "root",
        pullRequests: [
          {
            pullRequest: {
              url: `https://github.com/${REPO}/pull/7`,
              number: 7,
              title: "Add thing",
              state: "open",
              baseBranch: "main",
              headBranch: "feature",
            },
            source: "agent",
            linkedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            pullRequest: {
              url: `https://github.com/${REPO}/pull/9`,
              number: 9,
              title: "Add another thing",
              state: "open",
              baseBranch: "main",
              headBranch: "feature",
            },
            source: "manual",
            linkedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    ];
    expect(
      planReviewThreadAutoArchive(readModel(threads), new Set([`github.com/${REPO}#9`])),
    ).toEqual([{ threadId: "root", pullRequestKey: `github.com/${REPO}#9` }]);
  });

  it("builds a stable command id so a re-sweep deduplicates instead of erroring", () => {
    const threads = [reviewThread({ id: "root" })];
    const [first] = planReviewThreadAutoArchive(readModel(threads), mergedPullRequest7);
    const [second] = planReviewThreadAutoArchive(readModel(threads), mergedPullRequest7);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(reviewThreadMergeArchiveCommandId(first!)).toBe(
      reviewThreadMergeArchiveCommandId(second!),
    );
  });
});

describe("liveReviewThreadPullRequests", () => {
  it("asks about each distinct open pull request once, in project and repository order", () => {
    const threads = [
      reviewThread({ id: "root-b" }),
      reviewThread({
        id: "root-a",
        projectId: projectId("project-0"),
        pullRequests: [
          {
            pullRequest: {
              url: `https://github.com/other/repo/pull/3`,
              number: 3,
              title: "Fix thing",
              state: "open",
              baseBranch: "main",
              headBranch: "feature",
            },
            source: "agent",
            linkedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    ];
    expect(liveReviewThreadPullRequests(readModel(threads))).toEqual([
      {
        ref: { projectId: projectId("project-0"), repository: "other/repo", number: 3 },
        pullRequestKeys: ["github.com/other/repo#3"],
        recordedState: "unmerged",
      },
      {
        ref: { projectId: projectId("project-1"), repository: REPO, number: 7 },
        pullRequestKeys: [`github.com/${REPO}#7`],
        recordedState: "unmerged",
      },
    ] satisfies ReadonlyArray<ReviewThreadPullRequest>);
  });

  it("asks once about a pull request two review threads both watch, keeping both keys", () => {
    const threads = [reviewThread({ id: "root-a" }), reviewThread({ id: "root-b" })];
    expect(liveReviewThreadPullRequests(readModel(threads))).toEqual([
      {
        ref: { projectId: projectId("project-1"), repository: REPO, number: 7 },
        pullRequestKeys: [`github.com/${REPO}#7`],
        recordedState: "unmerged",
      },
    ]);
  });

  it("reports a recorded merge instead of asking, so the thread is still archived", () => {
    const threads = [
      reviewThread({
        id: "root",
        pullRequests: [
          {
            pullRequest: {
              url: `https://github.com/${REPO}/pull/7`,
              number: 7,
              title: "Add thing",
              state: "merged",
              baseBranch: "main",
              headBranch: "feature",
            },
            source: "agent",
            linkedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    ];
    expect(liveReviewThreadPullRequests(readModel(threads))).toEqual([
      {
        ref: { projectId: projectId("project-1"), repository: REPO, number: 7 },
        pullRequestKeys: [`github.com/${REPO}#7`],
        recordedState: "merged",
      },
    ] satisfies ReadonlyArray<ReviewThreadPullRequest>);
  });

  it("treats a pull request as merged when any thread records it that way", () => {
    const mergedLink = {
      pullRequest: {
        url: `https://github.com/${REPO}/pull/7`,
        number: 7,
        title: "Add thing",
        state: "merged" as const,
        baseBranch: "main",
        headBranch: "feature",
      },
      source: "agent" as const,
      linkedAt: "2026-01-01T00:00:00.000Z",
    };
    const threads = [
      reviewThread({ id: "root-a" }),
      reviewThread({ id: "root-b", pullRequests: [mergedLink] }),
    ];
    expect(liveReviewThreadPullRequests(readModel(threads))).toEqual([
      {
        ref: { projectId: projectId("project-1"), repository: REPO, number: 7 },
        pullRequestKeys: [`github.com/${REPO}#7`],
        recordedState: "merged",
      },
    ]);
  });

  it("does not report a review thread with a turn still running", () => {
    const threads = [
      reviewThread({
        id: "running",
        latestTurn: { turnId: "turn-1", state: "running", completedAt: null },
      }),
    ];
    expect(liveReviewThreadPullRequests(readModel(threads))).toEqual([]);
  });

  it("does not report an archived or settled review thread", () => {
    const threads = [
      reviewThread({ id: "archived", archivedAt: "2026-01-02T00:00:00.000Z" }),
      reviewThread({ id: "deleted", deletedAt: "2026-01-02T00:00:00.000Z" }),
      reviewThread({ id: "settled", settledOverride: "settled" }),
    ];
    expect(liveReviewThreadPullRequests(readModel(threads))).toEqual([]);
  });
});

/**
 * A review worker as `reviewChangesWorkflow.ts` actually builds one since
 * 8ba0d1103e: `pullRequest: null` keeps `CreatedPullRequestReviewReactor` from
 * reviewing the pull request it is reviewing, so the worker keeps no link and its
 * immutable review snapshot is the only remaining PR provenance.
 */
const REVIEW_WORKER_ID = ThreadId.make("workflow:run-1:node:review-changes:worker");
const REVIEWED_PULL_REQUEST_URL = "https://github.com/ronak-guliani/t3code/pull/590";

const snapshotOnlyReviewWorker = (
  overrides: { readonly id?: string } & Record<string, unknown> = {},
): OrchestrationThread =>
  ({
    projectId: projectId("project-1"),
    title: "Review PR #590",
    parentThreadId: "parent-thread",
    reviewSnapshot: {
      scope: {
        kind: "pull-request",
        number: 590,
        title: "Parallelize shell-summary reconciliation",
        url: REVIEWED_PULL_REQUEST_URL,
        baseBranch: "main",
        headBranch: "feature",
      },
    },
    reviewResult: { status: "parsed" },
    pullRequests: [],
    pullRequest: null,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    latestTurn: { turnId: "turn-1", state: "completed", completedAt: "2026-01-02T00:00:00.000Z" },
    id: REVIEW_WORKER_ID,
    ...overrides,
  }) as unknown as OrchestrationThread;

const mergedPullRequest590 = new Set(["github.com/ronak-guliani/t3code#590"]);

describe("review workers that carry only snapshot provenance", () => {
  it("asks about the reviewed pull request, which has no link to iterate", () => {
    const worker = snapshotOnlyReviewWorker();
    expect(worker.pullRequests).toEqual([]);
    expect(worker.pullRequest).toBeNull();
    expect(liveReviewThreadPullRequests(readModel([worker]))).toEqual([
      {
        ref: { projectId: projectId("project-1"), repository: "ronak-guliani/t3code", number: 590 },
        pullRequestKeys: ["github.com/ronak-guliani/t3code#590"],
        recordedState: "unmerged",
      },
    ] satisfies ReadonlyArray<ReviewThreadPullRequest>);
  });

  it("archives the worker once the reviewed pull request merges", () => {
    const worker = snapshotOnlyReviewWorker();
    expect(planReviewThreadAutoArchive(readModel([worker]), mergedPullRequest590)).toEqual([
      { threadId: REVIEW_WORKER_ID, pullRequestKey: "github.com/ronak-guliani/t3code#590" },
    ]);
  });

  it("accepts the worker at admission, so the archive dispatch is not refused", () => {
    const worker = snapshotOnlyReviewWorker();
    expect(canAutoArchiveThreadNow(readModel([worker]), REVIEW_WORKER_ID)).toBe(true);
  });

  it("leaves the worker alone while the reviewed pull request is still open", () => {
    const worker = snapshotOnlyReviewWorker();
    expect(planReviewThreadAutoArchive(readModel([worker]), new Set())).toEqual([]);
  });

  it("does not re-ask the provider when a link already names the same pull request", () => {
    const worker = snapshotOnlyReviewWorker({
      pullRequests: [
        {
          pullRequest: {
            url: REVIEWED_PULL_REQUEST_URL,
            number: 590,
            title: "Parallelize shell-summary reconciliation",
            state: "merged",
            baseBranch: "main",
            headBranch: "feature",
          },
          source: "agent",
          linkedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(liveReviewThreadPullRequests(readModel([worker]))).toEqual([
      {
        ref: { projectId: projectId("project-1"), repository: "ronak-guliani/t3code", number: 590 },
        pullRequestKeys: ["github.com/ronak-guliani/t3code#590"],
        recordedState: "merged",
      },
    ] satisfies ReadonlyArray<ReviewThreadPullRequest>);
  });

  it("ignores a snapshot whose scope is not a pull request", () => {
    const worker = snapshotOnlyReviewWorker({
      reviewSnapshot: { scope: { kind: "uncommitted" } },
    });
    expect(liveReviewThreadPullRequests(readModel([worker]))).toEqual([]);
  });
});
