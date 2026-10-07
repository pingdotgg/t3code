import { describe, expect, it } from "vite-plus/test";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  storageCleanupActivityAt,
  storageCleanupPullRequestMerged,
  storageCleanupThreadIdle,
} from "./storageCleanup.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("V2 storage cleanup eligibility", () => {
  const candidate = () => shell({ branch: "feature", worktreePath: "/worktrees/feature" });

  it("allows an idle worktree and rejects the project checkout", () => {
    expect(storageCleanupThreadIdle(candidate(), NOW_MS)).toBe(true);
    expect(storageCleanupThreadIdle(shell(), NOW_MS)).toBe(false);
  });

  it.each(["running", "starting", "preparing", "waiting", "queued"] as const)(
    "retains a worktree while its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS)).toBe(false);
    },
  );

  it.each(["idle", "completed", "interrupted", "failed", "cancelled", "rolled_back"] as const)(
    "allows cleanup once its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS)).toBe(true);
    },
  );

  it.each(["completed", "interrupted", "cancelled", "rolled_back"] as const)(
    "retains %s while background work is pending",
    (status) => {
      expect(
        storageCleanupThreadIdle(
          {
            ...candidateWithStatus(status),
            pendingBackgroundTasks: [{ taskId: "task-1", kind: "command" }],
          },
          NOW_MS,
        ),
      ).toBe(false);
    },
  );

  it.each(["completed", "interrupted", "cancelled", "rolled_back"] as const)(
    "retains %s while a runtime request is pending",
    (status) => {
      expect(
        storageCleanupThreadIdle(
          {
            ...candidateWithStatus(status),
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("request-1"),
              kind: "command",
              createdAt: at(0),
            },
          },
          NOW_MS,
        ),
      ).toBe(false);
    },
  );

  it("retains an active run even if the shell status is idle", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), activeRunId: RunId.make("run") }, NOW_MS),
    ).toBe(false);
  });

  it("retains a queued prompt before the new run has been projected", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), latestUserMessageAt: at(-1_000) }, NOW_MS),
    ).toBe(false);
  });

  it("uses V2 run activity instead of metadata refreshes for retention", () => {
    const thread = candidate();
    const runTime = at(-3 * DAY_MS);
    expect(
      storageCleanupActivityAt({ ...thread, latestRunCompletedAt: runTime, updatedAt: at(0) }),
    ).toBe(DateTime.toEpochMillis(runTime));
  });

  function candidateWithStatus(status: OrchestrationV2ThreadShell["status"]) {
    return { ...candidate(), status };
  }
});

describe("merged pull request cleanup", () => {
  const HEAD_SHA = "a".repeat(40);
  const integrated = {
    branch: "feature",
    defaultBranch: "main",
    headSha: HEAD_SHA,
    integrated: true,
  };
  const squashed = { ...integrated, integrated: false };
  const pullRequest = (
    overrides: Partial<NonNullable<Parameters<typeof storageCleanupPullRequestMerged>[0]>> = {},
  ) => ({
    state: "merged" as const,
    headRef: "feature",
    baseRef: "main",
    headSha: HEAD_SHA,
    ...overrides,
  });

  it("removes a worktree whose head reached the default branch through a merged pull request", () => {
    expect(storageCleanupPullRequestMerged(pullRequest({ headSha: null }), integrated)).toBe(true);
  });

  it("removes a squash-merged worktree when the pull request names its exact head", () => {
    expect(storageCleanupPullRequestMerged(pullRequest(), squashed)).toBe(true);
  });

  it.each([
    ["has a later commit than the merged head", { headSha: "c".repeat(40) }],
    ["was merged into a release branch", { baseRef: "release" }],
    ["was merged into its stack parent", { baseRef: "stack-parent" }],
    ["was merged without a reported head commit", { headSha: null }],
    ["belongs to a different branch", { headRef: "other" }],
    ["is still open", { state: "open" }],
    ["was closed without merging", { state: "closed" }],
  ] as const)("keeps a squash worktree whose pull request %s", (_name, overrides) => {
    expect(storageCleanupPullRequestMerged(pullRequest(overrides), squashed)).toBe(false);
  });

  it("keeps a worktree with no pull request, or one that is not merged", () => {
    expect(storageCleanupPullRequestMerged(null, squashed)).toBe(false);
    expect(storageCleanupPullRequestMerged(null, integrated)).toBe(false);
    expect(storageCleanupPullRequestMerged(pullRequest({ state: "open" }), integrated)).toBe(false);
  });
});
