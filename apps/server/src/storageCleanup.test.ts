import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  DEFAULT_SERVER_SETTINGS,
  GitCommandError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestratorV2 } from "./orchestration-v2/Orchestrator.ts";
import { ProjectionStoreV2 } from "./orchestration-v2/ProjectionStore.ts";
import * as Settings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { make, storageCleanupActivityAt, storageCleanupThreadIdle } from "./storageCleanup.ts";

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

it.effect.each([true, false])(
  "inspects linked Git worktrees only when jj is absent (jj: %s)",
  (hasJj) => {
    const status = vi.fn((cwd: string) =>
      Effect.fail(
        new GitCommandError({
          operation: "test.cleanupStatus",
          command: "git status",
          cwd,
          detail: "Stop after Git inspection.",
        }),
      ),
    );
    const remove = vi.fn(() => Effect.die("Git must not remove jj workspaces"));
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectRoot = yield* fs.makeTempDirectoryScoped();
      const worktreePath = path.join(config.worktreesDir, "jj-worktree");
      yield* fs.makeDirectory(worktreePath, { recursive: true });
      if (hasJj) yield* fs.makeDirectory(path.join(worktreePath, ".jj"));
      yield* fs.writeFileString(
        path.join(worktreePath, ".git"),
        "gitdir: /unused/git/worktrees/jj\n",
      );
      const inspected = yield* Deferred.make<void>();
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        storageCleanup: {
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeAfterDays: 1,
        },
      };
      yield* Effect.gen(function* () {
        const cleanup = yield* make;
        yield* cleanup.start();
        yield* Deferred.await(inspected);
        yield* cleanup.drain;
        expect(status).toHaveBeenCalledTimes(hasJj ? 0 : 1);
        expect(remove).not.toHaveBeenCalled();
        expect(yield* fs.exists(path.join(worktreePath, ".git"))).toBe(true);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Settings.ServerSettingsService)({
              getSettings: Effect.succeed(settings),
              subscribeChanges: Effect.succeed(Stream.empty),
            }),
            Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
              getProjectShellsWithoutEnrichment: () =>
                Effect.succeed([
                  {
                    id: ProjectId.make("project-1"),
                    title: "Project",
                    workspaceRoot: projectRoot,
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: DateTime.formatIso(at(0)),
                    updatedAt: DateTime.formatIso(at(0)),
                  },
                ]),
            }),
            Layer.mock(ProjectionStoreV2)({
              getShellSnapshot: (options) =>
                Deferred.succeed(inspected, undefined).pipe(
                  Effect.as({
                    schemaVersion: 1,
                    snapshotSequence: 0,
                    threads:
                      options?.location === "archive"
                        ? []
                        : [shell({ branch: "feature", worktreePath })],
                    archivedThreads: [],
                  }),
                ),
            }),
            Layer.mock(OrchestratorV2)({ streamDomainEvents: Stream.empty }),
            NodeSqliteClient.layer({ filename: ":memory:" }),
            Layer.mock(GitVcsDriver.GitVcsDriver)({
              statusDetailsLocal: status,
              removeWorktree: remove,
            }),
            Layer.mock(GitManager.GitManager)({}),
            Layer.mock(TerminalManager.TerminalManager)({
              subscribeMetadata: () => Effect.succeed(() => {}),
            }),
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-jj-cleanup-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  },
);
