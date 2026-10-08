import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import {
  storageCleanupActivityAt,
  storageCleanupPullRequestMerged,
  storageCleanupThreadIdle,
} from "./storageCleanup.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

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

describe("worktree remove action during cleanup", () => {
  // Runs one sweep over a worktree inactive for 30 days under a 1-day policy.
  // `onAction` runs inside the project's remove action.
  const sweepInactiveWorktree = (onAction: (resume: () => void) => void) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cleanup-repo-" });
      const worktreePath = path.join(config.worktreesDir, "repo", "t3-feature");
      yield* fs.makeDirectory(worktreePath, { recursive: true });
      // A linked worktree has a `.git` file, not a directory.
      yield* fs.writeFileString(path.join(worktreePath, ".git"), "gitdir: elsewhere\n");

      const calls: Array<string> = [];
      const actionRan = yield* Deferred.make<void>();
      const now = yield* Clock.currentTimeMillis;
      let thread = shell({
        branch: "feature",
        worktreePath,
        createdAt: DateTime.makeUnsafe(now - 30 * DAY_MS),
      });
      const resume = () => {
        // A message sent while the action runs starts a turn in the worktree.
        thread = {
          ...thread,
          status: "running",
          activeRunId: RunId.make("run-resumed"),
          latestUserMessageAt: DateTime.makeUnsafe(now),
        };
      };

      const cleanup = yield* StorageCleanup.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () =>
                Effect.succeed([
                  {
                    id: thread.projectId,
                    title: "Repo",
                    workspaceRoot: repoRoot,
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: "2026-06-01T00:00:00.000Z",
                    updatedAt: "2026-06-01T00:00:00.000Z",
                  },
                ]),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getShellSnapshot: (options) =>
                Effect.sync(() => ({
                  schemaVersion: 1,
                  snapshotSequence: 1,
                  threads: options?.location === "archive" ? [] : [thread],
                  archivedThreads: [],
                })),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
            Layer.mock(GitVcsDriver.GitVcsDriver)({
              statusDetailsLocal: () =>
                Effect.succeed({
                  isRepo: true,
                  hasOriginRemote: false,
                  isDefaultBranch: false,
                  branch: "feature",
                  upstreamRef: null,
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: false,
                  aheadCount: 0,
                  behindCount: 0,
                  aheadOfDefaultCount: 0,
                }),
              resolveCommit: () => Effect.succeed({ commitSha: "head-sha" }),
              execute: () =>
                Effect.succeed({
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout: "",
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }),
              removeWorktree: (input) =>
                Effect.sync(() => {
                  calls.push(`remove ${input.path}`);
                }),
            }),
            Layer.mock(GitManager.GitManager)({ invalidateStatus: () => Effect.void }),
            Layer.mock(TerminalManager.TerminalManager)({
              subscribeMetadata: () => Effect.succeed(() => undefined),
            }),
            Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
              runBeforeWorktreeRemove: (input) =>
                Effect.sync(() => {
                  calls.push(`action ${input.worktreePath}`);
                  onAction(resume);
                }).pipe(Effect.andThen(Deferred.succeed(actionRan, undefined))),
            }),
          ),
        ),
      );
      yield* cleanup.start();
      // `start` queues the first sweep from a background fiber. Once the action
      // runs, that sweep is in flight, so draining waits for it to finish.
      yield* Deferred.await(actionRan);
      yield* cleanup.drain;
      return { calls, worktreePath };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ storageCleanup: { worktreeAfterDays: 1 } }),
          SqlitePersistence.layerMemory,
        ).pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-storage-cleanup-" }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );

  it.live("runs the remove action, then removes an inactive worktree", () =>
    Effect.gen(function* () {
      const { calls, worktreePath } = yield* sweepInactiveWorktree(() => undefined);
      expect(calls).toEqual([`action ${worktreePath}`, `remove ${worktreePath}`]);
    }).pipe(Effect.scoped),
  );

  it.live("keeps a worktree whose thread resumes while its remove action runs", () =>
    Effect.gen(function* () {
      const { calls, worktreePath } = yield* sweepInactiveWorktree((resume) => resume());
      expect(calls).toEqual([`action ${worktreePath}`]);
    }).pipe(Effect.scoped),
  );
});
