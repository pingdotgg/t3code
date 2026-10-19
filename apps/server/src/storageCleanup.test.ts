import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { SCAN_CACHE_FILE_NAME } from "./usage/usageScanCache.ts";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import {
  DEFAULT_SERVER_SETTINGS,
  StorageCleanupReport,
  type WorktreeKeepWhen,
  type StorageCleanupSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "./config.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Settings from "./serverSettings.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ServerActivation } from "./serverActivation.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderSession,
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
const decodeCleanupReport = Schema.decodeSync(StorageCleanupReport);

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

const allocatedBytes = (fs: FileSystem.FileSystem, file: string) =>
  fs.stat(file).pipe(
    Effect.map((stat) =>
      Option.getOrElse(
        Option.map(stat.blocks, (blocks) => Number(blocks) * 512),
        () => Number(stat.size),
      ),
    ),
  );

const cleanupFixture = (
  storageCleanup: StorageCleanupSettings = {
    ...DEFAULT_SERVER_SETTINGS.storageCleanup,
    worktreeAfterDays: 8,
    worktreeOnDelete: true,
  },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repo = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-repo-" });
    const command = (cwd: string, args: string[]) =>
      git.execute({ operation: "cleanup-test", cwd, args });
    yield* command(repo, ["init", "-b", "main"]);
    yield* command(repo, ["config", "user.email", "cleanup@example.test"]);
    yield* command(repo, ["config", "user.name", "Cleanup test"]);
    yield* fs.writeFileString(`${repo}/tracked.txt`, "original\n");
    yield* fs.writeFileString(`${repo}/.gitignore`, ".env\ndist/\nnode_modules/\n");
    yield* command(repo, ["add", "."]);
    yield* command(repo, ["commit", "-m", "initial"]);
    yield* fs.makeDirectory(config.worktreesDir, { recursive: true });
    const worktree = `${config.worktreesDir}/feature`;
    yield* command(repo, ["worktree", "add", "-b", "feature", worktree]);
    let settings: import("@t3tools/contracts").ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      storageCleanup,
    };
    let threads = [shell({ branch: "feature", worktreePath: worktree })];
    let storedWorktreePaths: string[] = [worktree];
    let projectRoots = [repo];
    let editBeforeRemoval = false;
    let openSessionCwd: string | null = null;
    let sessionLive = true;
    let fullStatusCalls = 0;
    let snapshotReads = 0;
    let events: Stream.Stream<OrchestrationV2DomainEvent> = Stream.empty;
    const activated = yield* Deferred.make<void>();
    const context = yield* Layer.build(StorageCleanup.layer).pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, {
        ...git,
        execute: (input) =>
          Effect.gen(function* () {
            if (editBeforeRemoval && input.args.includes("remove"))
              yield* fs.writeFileString(`${worktree}/tracked.txt`, "late edit\n");
            return yield* git.execute(input);
          }),
        statusDetailsLocal: (...args) => {
          fullStatusCalls++;
          return git.statusDetailsLocal(...args);
        },
      }),
      Effect.provideService(Settings.ServerSettingsService, {
        getSettings: Effect.sync(() => settings),
        subscribeChanges: Effect.succeed(Stream.empty),
      } as unknown as Settings.ServerSettingsService["Service"]),
      Effect.provideService(ProjectStore.ProjectStoreV2, {
        list: () => Effect.sync(() => projectRoots.map((workspaceRoot) => ({ workspaceRoot }))),
        listShells: () =>
          Effect.sync(() =>
            projectRoots.map((workspaceRoot, index) => ({
              id: ProjectId.make(`project-${index + 1}`),
              workspaceRoot,
            })),
          ),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, {
        getShellSnapshot: (input?: { location?: string }) =>
          Effect.sync(() => {
            snapshotReads++;
            const visible = threads.filter((thread) => thread.deletedAt === null);
            return {
              threads:
                input?.location === "archive"
                  ? []
                  : visible.filter((thread) => thread.archivedAt === null),
              archivedThreads:
                input?.location === "active"
                  ? []
                  : visible.filter((thread) => thread.archivedAt !== null),
            };
          }),
        getThreadWorktreePaths: (input?: { includeArchived?: boolean }) =>
          Effect.sync(() =>
            threads.flatMap((thread) =>
              thread.deletedAt === null &&
              (input?.includeArchived === true || thread.archivedAt === null) &&
              thread.worktreePath !== null
                ? [{ threadId: thread.id, worktreePath: thread.worktreePath }]
                : [],
            ),
          ),
        getThreadShell: (threadId: ThreadId) =>
          Effect.sync(() => threads.find((thread) => thread.id === threadId) ?? null),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
        isLive: () => Effect.sync(() => sessionLive),
      } as unknown as ProviderSessionManager.ProviderSessionManagerV2["Service"]),
      Effect.provideService(Orchestrator.OrchestratorV2, {
        streamDomainEvents: Stream.suspend(() => events),
      } as unknown as Orchestrator.OrchestratorV2["Service"]),
      Effect.provideService(SqlClient.SqlClient, ((strings: TemplateStringsArray) =>
        Effect.sync(() =>
          openSessionCwd !== null && strings.join("").includes("projection_provider_sessions")
            ? [
                {
                  payload_json: JSON.stringify({
                    id: "session-1",
                    driver: "codex",
                    providerInstanceId: "codex",
                    status: "ready",
                    cwd: openSessionCwd,
                    model: null,
                    capabilities: CodexProviderCapabilitiesV2,
                    createdAt: "2026-06-01T12:00:00.000Z",
                    updatedAt: "2026-06-01T12:00:00.000Z",
                    lastError: null,
                  }),
                },
              ]
            : strings.join("").includes('AS "worktreePath"')
              ? [
                  ...threads.flatMap((thread) => thread.worktreePath ?? []),
                  ...storedWorktreePaths,
                ].map((worktreePath) => ({ worktreePath }))
              : [],
        )) as unknown as SqlClient.SqlClient),
      Effect.provideService(GitManager.GitManager, {
        invalidateStatus: () => Effect.void,
      } as unknown as GitManager.GitManager["Service"]),
      Effect.provideService(TerminalManager.TerminalManager, {
        subscribeMetadata: () => Effect.succeed(() => {}),
      } as unknown as TerminalManager.TerminalManager["Service"]),
      Effect.provideService(ServerActivation, Deferred.await(activated)),
    );
    return {
      service: Context.get(context, StorageCleanup.StorageCleanup),
      repo,
      editBeforeRemoval: () => {
        editBeforeRemoval = true;
      },
      fs,
      worktree,
      config,
      command,
      enableFiles: () => {
        settings = {
          ...settings,
          storageCleanup: {
            ...settings.storageCleanup,
            browserArtifactsAfterDays: 8,
            logsAfterDays: 8,
          },
        };
      },
      setSettings: (next: Partial<typeof settings>) => {
        settings = { ...settings, ...next };
      },
      setPolicy: (worktreeKeepWhen: WorktreeKeepWhen) => {
        settings = {
          ...settings,
          storageCleanup: { ...settings.storageCleanup, worktreeKeepWhen },
        };
      },
      disable: () => {
        settings = {
          ...settings,
          storageCleanup: {
            ...settings.storageCleanup,
            worktreeAfterDays: null,
            worktreeOnDelete: false,
          },
        };
      },
      setThreads: (next: typeof threads) => {
        threads = next;
      },
      setStoredWorktreePaths: (paths: string[]) => {
        storedWorktreePaths = paths;
      },
      setProjectRoots: (roots: string[]) => {
        projectRoots = roots;
      },
      setSessionLive: (live: boolean) => {
        sessionLive = live;
      },
      setOpenSessionCwd: (cwd: string | null) => {
        openSessionCwd = cwd;
      },
      fullStatusCalls: () => fullStatusCalls,
      snapshotReads: () => snapshotReads,
      activate: (domainEvents: Stream.Stream<OrchestrationV2DomainEvent>) => {
        events = domainEvents;
        return Deferred.succeed(activated, undefined);
      },
    };
  });
const pausedMeasurementFixture = (storageCleanup?: StorageCleanupSettings) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const measuring = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let measuredPath: string | undefined;
    const fixture = yield* cleanupFixture(storageCleanup).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readDirectory: (directory, options) =>
          Effect.gen(function* () {
            if (directory === measuredPath) {
              yield* Deferred.succeed(measuring, undefined);
              yield* Deferred.await(resume);
            }
            return yield* fs.readDirectory(directory, options);
          }),
      }),
    );
    measuredPath = yield* fs.realPath(fixture.worktree);
    return { ...fixture, measuring, resume };
  });
const sessionUpdated = (
  index: number,
  status: OrchestrationV2ProviderSession["status"],
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event-${index}`),
  type: "provider-session.updated",
  threadId: ThreadId.make("thread-1"),
  occurredAt: at(0),
  payload: {
    id: ProviderSessionId.make(`session-${index}`),
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    status,
    cwd: "/elsewhere",
    model: null,
    capabilities: CodexProviderCapabilitiesV2,
    createdAt: at(0),
    updatedAt: at(0),
    lastError: null,
  },
});
const cleanupTestLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "storage-cleanup-" })),
  Layer.provideMerge(NodeServices.layer),
);
const runCleanupTest = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | ServerConfig.ServerConfig
    | GitVcsDriver.GitVcsDriver
    | Path.Path
    | Scope.Scope
  >,
) => effect.pipe(Effect.provide(cleanupTestLayer), Effect.scoped);

describe("subagent worktree ownership", () => {
  it.effect.each([
    "idle",
    "grandchild",
    "null-branch",
    "stale-branch",
    "isolated-owner",
    "fork-owner",
    "missing-parent",
    "cycle",
    "two-tops",
    "wrong-root",
    "running",
    "pending",
    "unrelated",
    "fork",
    "recent-activity",
    "recent-inactive",
    "recent-grace",
    "recent-settle",
    "child-settled-now",
    "child-settled-only",
  ] as const)("checks the whole owner group (%s)", (scenario) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture();
      fixture.setSettings({
        storageCleanup: {
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeSettledAfterDays: scenario === "recent-inactive" ? null : 8,
          worktreeAfterDays: scenario === "recent-inactive" ? 8 : null,
        },
      });
      const root = shell({
        branch: "feature",
        worktreePath: fixture.worktree,
        settledAt: scenario === "child-settled-only" ? null : at(-20 * DAY_MS),
        ...(scenario === "isolated-owner" || scenario === "fork-owner"
          ? {
              lineage: {
                parentThreadId: ThreadId.make("ancestor"),
                rootThreadId: ThreadId.make("ancestor"),
                relationshipToParent:
                  scenario === "fork-owner" ? ("fork" as const) : ("subagent" as const),
              },
            }
          : {}),
      });
      const child = shell({
        id: ThreadId.make("child"),
        branch:
          scenario === "null-branch"
            ? null
            : scenario === "stale-branch"
              ? "t3/15a6e5ae"
              : "feature",
        worktreePath: fixture.worktree,
        lineage: {
          parentThreadId:
            scenario === "missing-parent"
              ? ThreadId.make("missing")
              : scenario === "cycle"
                ? ThreadId.make("child")
                : scenario === "two-tops"
                  ? null
                  : root.id,
          rootThreadId:
            scenario === "wrong-root" ? ThreadId.make("other-root") : root.lineage.rootThreadId,
          relationshipToParent:
            scenario === "fork" ? "fork" : scenario === "unrelated" ? null : "subagent",
        },
        status: scenario === "running" ? "running" : "completed",
        pendingBackgroundTasks: scenario === "pending" ? [{ taskId: "task", kind: "command" }] : [],
        latestRunCompletedAt:
          scenario === "recent-activity" || scenario === "recent-inactive"
            ? at(-2 * DAY_MS)
            : scenario === "recent-grace"
              ? at(-30_000)
              : null,
        settledAt: scenario === "child-settled-only" ? at(-20 * DAY_MS) : null,
      });
      const grandchild = {
        ...child,
        id: ThreadId.make("grandchild"),
        lineage: { ...child.lineage, parentThreadId: child.id },
      };
      // The worktree owner can follow its children in the snapshot.
      fixture.setThreads(
        scenario === "grandchild"
          ? [grandchild, child, root]
          : scenario === "isolated-owner" || scenario === "fork-owner"
            ? [child, root, shell({ id: ThreadId.make("ancestor") })]
            : [child, root],
      );
      if (scenario === "recent-settle" || scenario === "child-settled-now")
        fixture.setThreads([
          {
            ...child,
            settledAt: scenario === "recent-settle" ? at(0) : at(-20 * DAY_MS),
            updatedAt: at(0),
          },
          root,
        ]);
      const report = yield* fixture.service.runNow;
      const removed = ["idle", "grandchild", "isolated-owner", "fork-owner"].includes(scenario);
      const shared = [
        "unrelated",
        "fork",
        "missing-parent",
        "cycle",
        "two-tops",
        "wrong-root",
      ].includes(scenario);
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(!removed);
      expect(report.entries[0]).toMatchObject({
        threadId: shared ? child.id : root.id,
        outcome: removed ? "removed" : "kept",
        reason: removed
          ? "Settled for 20 days"
          : scenario === "running" || scenario === "pending"
            ? "Thread is running or has pending work"
            : shared
              ? "Shared by 2 threads"
              : scenario === "null-branch" || scenario === "stale-branch"
                ? "A subagent thread's branch differs from this worktree's branch"
                : scenario === "recent-activity"
                  ? "Settled for 2 of 8 days"
                  : scenario === "recent-inactive"
                    ? "Inactive for 2 of 8 days"
                    : ["recent-grace", "recent-settle", "child-settled-now"].includes(scenario)
                      ? "Settled moments ago"
                      : "Not settled",
      });
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.live.each([
    "running",
    "pending",
    "activity",
    "unrelated",
    "settled",
    "resettled",
    "null-branch",
    "stale-branch",
  ] as const)("cancels removal when a child changes during measurement (%s)", (change) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* pausedMeasurementFixture();
        const root = shell({ branch: "feature", worktreePath: fixture.worktree });
        const child = {
          ...root,
          id: ThreadId.make("child"),
          settledAt: change === "resettled" ? at(-20 * DAY_MS) : null,
          lineage: {
            parentThreadId: root.id,
            rootThreadId: root.id,
            relationshipToParent: "subagent" as const,
          },
        };
        fixture.setThreads([child, root]);
        const run = yield* fixture.service.runNow.pipe(Effect.forkChild);
        yield* Deferred.await(fixture.measuring);
        fixture.setThreads([
          root,
          {
            ...child,
            branch:
              change === "null-branch"
                ? null
                : change === "stale-branch"
                  ? "t3/15a6e5ae"
                  : child.branch,
            settledAt: change === "settled" ? at(-20 * DAY_MS) : child.settledAt,
            updatedAt: change === "settled" || change === "resettled" ? at(0) : child.updatedAt,
            status: change === "running" ? "running" : "idle",
            pendingBackgroundTasks:
              change === "pending" ? [{ taskId: "task", kind: "command" }] : [],
            latestRunCompletedAt: change === "activity" ? at(-DAY_MS) : null,
          },
          ...(change === "unrelated" ? [shell({ ...root, id: ThreadId.make("other") })] : []),
        ]);
        yield* Deferred.succeed(fixture.resume, undefined);
        expect((yield* Fiber.join(run)).entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Thread activity or shared worktree changed since check",
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
      }),
    ),
  );
});

describe("orphan worktree reports", () => {
  it.live("keeps orphan results visible when thread results fill the report", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads(
          Array.from({ length: 205 }, (_, index) =>
            shell({
              id: ThreadId.make(`busy-${index}`),
              branch: "busy",
              worktreePath: `${fixture.config.worktreesDir}/busy-${index}`,
              status: "running",
            }),
          ),
        );
        for (let index = 0; index < 205; index++) {
          yield* fixture.fs.makeDirectory(`${fixture.config.worktreesDir}/busy-${index}`);
        }
        const orphans = ["one", "two"].map(
          (name) => `${fixture.config.worktreesDir}/repository/${name}`,
        );
        for (const orphan of orphans) {
          yield* fixture.fs.makeDirectory(orphan, { recursive: true });
          yield* fixture.fs.utimes(orphan, 1, 1);
        }
        const report = yield* fixture.service.runNow;
        expect(report.entries).toHaveLength(200);
        expect(
          report.entries
            .slice(0, 2)
            .map((entry) => entry.path)
            .sort(),
        ).toEqual(orphans);
        expect(report.counts).toEqual({ removed: 0, kept: 207, failed: 0 });
        expect(report.omittedCount).toBe(7);
      }),
    ),
  );

  it.live.each(["canonical", "win32", "linux"] as const)(
    "skips an ancestor of a referenced thread worktree (%s)",
    (platform) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture().pipe(
            Effect.provideService(HostProcess.Platform, platform === "win32" ? "win32" : "linux"),
          );
          fixture.setThreads([]);
          const ancestor = `${fixture.config.worktreesDir}/repository/stack`;
          const worktree = `${ancestor}/feature`;
          yield* fixture.command(fixture.repo, ["worktree", "add", "-b", "nested", worktree]);
          const alias = `${fixture.repo}/alias`;
          if (platform === "canonical") yield* fixture.fs.symlink(worktree, alias);
          fixture.setStoredWorktreePaths([
            platform === "canonical"
              ? alias
              : platform === "win32"
                ? worktree.toUpperCase()
                : worktree,
          ]);
          yield* fixture.fs.utimes(ancestor, 1, 1);
          expect((yield* fixture.service.runNow).entries).toEqual([]);
          expect(yield* fixture.fs.exists(worktree)).toBe(true);
        }),
      ),
  );

  it.live("waits an hour before reporting a folder without a thread row", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const folder = `${fixture.config.worktreesDir}/review-guide-123/checkout`;
        yield* fixture.command(fixture.repo, ["worktree", "add", "-b", "review", folder]);
        expect((yield* fixture.service.runNow).entries).toEqual([]);
        yield* fixture.fs.utimes(folder, 1, 1);
        expect((yield* fixture.service.runNow).entries).toEqual([
          expect.objectContaining({
            path: folder,
            outcome: "kept",
            reason: "No thread uses this worktree",
          }),
        ]);
        expect(yield* fixture.fs.exists(`${folder}/tracked.txt`)).toBe(true);
      }),
    ),
  );

  it.live("continues reporting when a project root cannot be probed", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const loop = `${fixture.repo}/loop`;
        yield* fixture.fs.symlink(loop, loop);
        fixture.setProjectRoots([fixture.repo, loop]);
        const orphan = `${fixture.config.worktreesDir}/repository/orphan`;
        yield* fixture.fs.makeDirectory(orphan, { recursive: true });
        yield* fixture.fs.utimes(orphan, 1, 1);
        expect((yield* fixture.service.runNow).entries).toEqual([
          expect.objectContaining({ path: orphan, outcome: "kept", bytes: 0 }),
        ]);
      }),
    ),
  );

  it.effect.each(["walk-timeout", "sweep-budget"] as const)(
    "caches walk timeouts and retries budget-cut orphan sizes (%s)",
    (limit) =>
      runCleanupTest(
        Effect.gen(function* () {
          yield* TestClock.setTime(NOW_MS);
          const fs = yield* FileSystem.FileSystem;
          const measuring = yield* Deferred.make<void>();
          let orphan = "";
          let walks = 0;
          const fixture = yield* cleanupFixture().pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readDirectory: (directory, options) =>
                Effect.gen(function* () {
                  if (directory.endsWith("/repository") && walks === 0)
                    yield* TestClock.adjust("1 second");
                  if (directory === orphan) {
                    walks++;
                    if (limit === "walk-timeout" || walks === 1) {
                      yield* Deferred.succeed(measuring, undefined);
                      return yield* Effect.never;
                    }
                  }
                  return (yield* fs.readDirectory(directory, options)).sort();
                }),
            }),
          );
          fixture.setThreads([]);
          orphan = `${fixture.config.worktreesDir}/repository/orphan`;
          yield* fs.makeDirectory(orphan, { recursive: true });
          yield* fs.writeFileString(`${orphan}/file`, "x");
          const bytes = yield* allocatedBytes(fs, `${orphan}/file`);
          yield* fs.utimes(orphan, 1, 1);
          const later = `${fixture.config.worktreesDir}/repository/z-later`;
          yield* fs.makeDirectory(later);
          yield* fs.utimes(later, 1, 1);
          if (limit === "sweep-budget") {
            const first = `${fixture.config.worktreesDir}/repository/a-first`;
            yield* fs.makeDirectory(first);
            yield* fs.utimes(first, 1, 1);
          }
          const orphanEntry = (report: StorageCleanupReport) =>
            report.entries.find((entry) => entry.path === orphan);
          const sweep = yield* fixture.service.runNow.pipe(Effect.forkChild);
          yield* Deferred.await(measuring);
          yield* TestClock.adjust(limit === "walk-timeout" ? "30 seconds" : "29 seconds");
          const firstReport = yield* Fiber.join(sweep);
          expect(orphanEntry(firstReport)?.bytes).toBeNull();
          expect(firstReport.entries.find((entry) => entry.path === later)?.bytes).toBeNull();
          const nextReport = yield* fixture.service.runNow;
          expect(orphanEntry(nextReport)?.bytes).toBe(limit === "walk-timeout" ? null : bytes);
          expect(nextReport.entries.find((entry) => entry.path === later)?.bytes).toBe(0);
          yield* fs.writeFileString(`${orphan}/file`, "changed".repeat(10_000));
          const changedBytes = yield* allocatedBytes(fs, `${orphan}/file`);
          expect(changedBytes).not.toBe(bytes);
          expect(orphanEntry(yield* fixture.service.runNow)?.bytes).toBe(
            limit === "walk-timeout" ? null : bytes,
          );
          expect(walks).toBe(limit === "walk-timeout" ? 1 : 2);
          if (limit === "walk-timeout") return;
          fixture.setStoredWorktreePaths([orphan]);
          expect(orphanEntry(yield* fixture.service.runNow)).toBeUndefined();
          fixture.setStoredWorktreePaths([]);
          expect(orphanEntry(yield* fixture.service.runNow)?.bytes).toBe(changedBytes);
          expect(walks).toBe(3);
        }),
      ),
  );

  it.live.each(["nested", "direct"] as const)(
    "reports a linked orphan's size without removing its files (%s)",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setThreads([]);
          const orphan = `${fixture.config.worktreesDir}/${location === "nested" ? "repository/" : ""}orphan`;
          yield* fixture.command(fixture.repo, ["worktree", "add", "-b", "orphan", orphan]);
          const sizes = yield* Effect.forEach(yield* fixture.fs.readDirectory(orphan), (name) =>
            allocatedBytes(fixture.fs, `${orphan}/${name}`),
          );
          const outside = yield* fixture.fs.makeTempDirectoryScoped();
          yield* fixture.fs.writeFileString(`${outside}/external`, "outside data");
          yield* fixture.fs.symlink(outside, `${orphan}/linked-directory`);
          yield* fixture.fs.symlink(`${outside}/missing`, `${orphan}/dangling-link`);
          yield* fixture.fs.utimes(orphan, 1, 1);
          const report = yield* fixture.service.runNow;
          expect(report.entries).toEqual([
            {
              kind: "worktree",
              outcome: "kept",
              reason: "No thread uses this worktree",
              path: orphan,
              threadId: null,
              threadTitle: null,
              bytes: sizes.reduce((sum, size) => sum + size, 0),
              files: null,
            },
          ]);
          expect(report.bytesFreed).toBe(0);
          expect(yield* fixture.fs.readFileString(`${orphan}/tracked.txt`)).toBe("original\n");
          expect(yield* fixture.fs.readFileString(`${outside}/external`)).toBe("outside data");
          expect(
            (yield* fixture.command(orphan, ["rev-parse", "--is-inside-work-tree"])).stdout.trim(),
          ).toBe("true");
        }),
      ),
  );

  it.live.each(["active", "outside-active-snapshot"] as const)(
    "does not report a folder referenced by a thread (%s)",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          const worktreePath = `${fixture.config.worktreesDir}/repository/referenced`;
          yield* fixture.command(fixture.repo, [
            "worktree",
            "add",
            "-b",
            "referenced",
            worktreePath,
          ]);
          fixture.setThreads(
            location === "active"
              ? [shell({ branch: "referenced", worktreePath, status: "running" })]
              : [],
          );
          if (location !== "active")
            fixture.setStoredWorktreePaths([fixture.worktree, worktreePath]);
          yield* fixture.fs.utimes(worktreePath, 1, 1);
          const report = yield* fixture.service.runNow;
          expect(report.entries.filter((entry) => entry.threadId === null)).toEqual([]);
          expect(yield* fixture.fs.exists(worktreePath)).toBe(true);
        }),
      ),
  );

  it.live.each(["exact", "nested", "symlink"] as const)(
    "does not report a folder containing a project checkout (%s)",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setThreads([]);
          const worktreePath = `${fixture.config.worktreesDir}/repository/project-checkout`;
          yield* fixture.fs.makeDirectory(`${worktreePath}/nested`, { recursive: true });
          const alias = `${fixture.repo}/alias`;
          if (location === "symlink") yield* fixture.fs.symlink(`${worktreePath}/nested`, alias);
          fixture.setProjectRoots([
            fixture.repo,
            location === "exact"
              ? worktreePath
              : location === "nested"
                ? `${worktreePath}/nested`
                : alias,
          ]);
          yield* fixture.fs.utimes(worktreePath, 1, 1);
          expect((yield* fixture.service.runNow).entries).toEqual([]);
          expect(yield* fixture.fs.exists(worktreePath)).toBe(true);
        }),
      ),
  );

  it.live.each(["exact", "contains", "symlink"] as const)(
    "does not report project internals under a custom managed root (%s)",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setThreads([]);
          const source = `${fixture.repo}/src`;
          yield* fixture.fs.makeDirectory(`${source}/nested/deep`, { recursive: true });
          const alias = `${fixture.config.worktreesDir}/project-alias`;
          if (location === "symlink") {
            yield* fixture.fs.symlink(fixture.repo, alias);
            fixture.setProjectRoots([alias]);
          }
          if (location === "contains") fixture.setProjectRoots([fixture.repo, `${source}/nested`]);
          fixture.setSettings({
            worktreesDirectory: location === "contains" ? source : fixture.repo,
          });
          expect((yield* fixture.service.runNow).entries).toEqual([]);
          expect(yield* fixture.fs.exists(`${source}/nested/deep`)).toBe(true);
        }),
      ),
  );

  it.live.each(["direct", "symlink"] as const)(
    "reports an orphan under a managed root inside a project (%s)",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const walked: string[] = [];
          const fixture = yield* cleanupFixture().pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readDirectory: (directory, options) => {
                walked.push(directory);
                return fs.readDirectory(directory, options);
              },
            }),
          );
          fixture.setThreads([]);
          const root = `${fixture.repo}/.worktrees`;
          const orphan = `${root}/repository/orphan`;
          const source = `${fixture.repo}/src`;
          yield* fs.makeDirectory(`${source}/nested/deep`, { recursive: true });
          yield* fixture.command(fixture.repo, ["worktree", "add", "-b", "orphan", orphan]);
          if (location === "symlink") {
            const alias = `${fixture.config.worktreesDir}/project-alias`;
            yield* fs.symlink(fixture.repo, alias);
            fixture.setProjectRoots([alias]);
          }
          fixture.setSettings({ worktreesDirectory: root });
          yield* fs.utimes(orphan, 1, 1);
          const report = yield* fixture.service.runNow;
          expect(report.entries).toEqual([
            expect.objectContaining({
              path: orphan,
              outcome: "kept",
              reason: "No thread uses this worktree",
            }),
          ]);
          expect(walked.some((directory) => directory.startsWith(source))).toBe(false);
          expect(yield* fs.readFileString(`${orphan}/tracked.txt`)).toBe("original\n");
        }),
      ),
  );

  it.live("reports an orphan containing a removed project checkout", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const orphan = `${fixture.config.worktreesDir}/repository/orphan`;
        const removed = `${orphan}/removed-checkout`;
        yield* fixture.command(fixture.repo, ["worktree", "add", "-b", "orphan", orphan]);
        yield* fixture.fs.makeDirectory(removed);
        yield* fixture.fs.remove(removed, { recursive: true });
        fixture.setProjectRoots([fixture.repo, removed]);
        yield* fixture.fs.utimes(orphan, 1, 1);
        const report = yield* fixture.service.runNow;
        expect(report.entries).toEqual([
          expect.objectContaining({
            path: orphan,
            outcome: "kept",
            reason: "No thread uses this worktree",
          }),
        ]);
        expect(yield* fixture.fs.readFileString(`${orphan}/tracked.txt`)).toBe("original\n");
      }),
    ),
  );

  it.live("skips project workspace internals while reporting a real orphan sibling", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const project = `${fixture.config.worktreesDir}/project-checkout`;
        const orphan = `${fixture.config.worktreesDir}/repository/orphan`;
        yield* fixture.fs.makeDirectory(`${project}/src/nested`, { recursive: true });
        yield* fixture.fs.makeDirectory(orphan, { recursive: true });
        yield* fixture.fs.writeFileString(`${orphan}/file`, "x");
        fixture.setProjectRoots([fixture.repo, project]);
        yield* fixture.fs.utimes(orphan, 1, 1);
        const report = yield* fixture.service.runNow;
        expect(report.entries).toEqual([
          expect.objectContaining({
            path: orphan,
            outcome: "kept",
            bytes: yield* allocatedBytes(fixture.fs, `${orphan}/file`),
          }),
        ]);
        expect(yield* fixture.fs.exists(`${project}/src/nested`)).toBe(true);
        expect(yield* fixture.fs.exists(orphan)).toBe(true);
      }),
    ),
  );

  it.live("skips symbolic links at both directory levels and disabled cleanup", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const outside = yield* fixture.fs.makeTempDirectoryScoped();
        yield* fixture.fs.makeDirectory(`${outside}/checkout`);
        const projectDirectory = `${fixture.config.worktreesDir}/repository`;
        yield* fixture.fs.makeDirectory(projectDirectory);
        yield* fixture.fs.symlink(outside, `${fixture.config.worktreesDir}/linked-project`);
        yield* fixture.fs.symlink(`${outside}/checkout`, `${projectDirectory}/linked-checkout`);
        yield* fixture.fs.symlink(`${outside}/missing`, `${projectDirectory}/dangling-link`);
        expect((yield* fixture.service.runNow).entries).toEqual([]);
        const orphan = `${projectDirectory}/orphan`;
        yield* fixture.fs.makeDirectory(orphan);
        fixture.disable();
        expect((yield* fixture.service.runNow).entries).toEqual([]);
        expect(yield* fixture.fs.exists(orphan)).toBe(true);
      }),
    ),
  );

  it.live("reports ordinary folders with an honest reason and keeps their files", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const folder = `${fixture.config.worktreesDir}/repository/leftover`;
        yield* fixture.fs.makeDirectory(folder, { recursive: true });
        yield* fixture.fs.writeFileString(`${folder}/payload`, "leftover data");
        yield* fixture.fs.utimes(folder, 1, 1);
        const report = yield* fixture.service.runNow;
        expect(report.entries).toEqual([
          expect.objectContaining({
            path: folder,
            outcome: "kept",
            bytes: yield* allocatedBytes(fixture.fs, `${folder}/payload`),
            reason: "No thread uses this folder, and it isn't a git worktree",
          }),
        ]);
        expect(report.bytesFreed).toBe(0);
        expect(yield* fixture.fs.readFileString(`${folder}/payload`)).toBe("leftover data");
      }),
    ),
  );

  it.live("continues after an inaccessible directory's git probe", (context) =>
    runCleanupTest(
      Effect.gen(function* () {
        if ((yield* HostProcess.isWindows) || (yield* HostProcess.UserId) === 0)
          return context.skip();
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const blocked = `${fixture.config.worktreesDir}/a-inaccessible`;
        const orphan = `${fixture.config.worktreesDir}/z-repository/orphan`;
        yield* fixture.fs.makeDirectory(blocked);
        yield* fixture.fs.makeDirectory(orphan, { recursive: true });
        yield* fixture.fs.writeFileString(`${orphan}/file`, "x");
        yield* fixture.fs.chmod(blocked, 0);
        yield* fixture.fs.utimes(orphan, 1, 1);
        const report = yield* fixture.service.runNow.pipe(
          Effect.ensuring(fixture.fs.chmod(blocked, 0o700).pipe(Effect.orDie)),
        );
        expect(report.entries).toEqual([
          expect.objectContaining({
            path: orphan,
            outcome: "kept",
            bytes: yield* allocatedBytes(fixture.fs, `${orphan}/file`),
          }),
        ]);
        expect(yield* fixture.fs.exists(orphan)).toBe(true);
      }),
    ),
  );

  it.live.each(["win32", "linux"] as const)(
    "compares thread paths with host casing rules and excludes existing projects (%s)",
    (platform) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture().pipe(
            Effect.provideService(HostProcess.Platform, platform),
          );
          fixture.setThreads([]);
          const parent = `${fixture.config.worktreesDir}/repository`;
          const referenced = `${parent}/Referenced`;
          const project = `${parent}/Project`;
          const nested = `${parent}/Nested`;
          for (const folder of [referenced, project, nested]) {
            yield* fixture.fs.makeDirectory(`${folder}/child`, { recursive: true });
            yield* fixture.fs.utimes(folder, 1, 1);
          }
          fixture.setStoredWorktreePaths([fixture.worktree, referenced.toUpperCase()]);
          fixture.setProjectRoots([fixture.repo, project, `${nested}/child`]);
          const report = yield* fixture.service.runNow;
          expect(report.entries.map((entry) => entry.path).sort()).toEqual(
            platform === "win32" ? [] : [referenced],
          );
        }),
      ),
  );

  it.live("caps orphan entries while preserving kept totals", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        for (let i = 0; i < 205; i++) {
          const orphan = `${fixture.config.worktreesDir}/repository/orphan-${i}`;
          yield* fixture.fs.makeDirectory(orphan, { recursive: true });
          yield* fixture.fs.writeFileString(`${orphan}/file`, "x");
          yield* fixture.fs.utimes(orphan, 1, 1);
        }
        const report = yield* fixture.service.runNow;
        expect(report.entries).toHaveLength(200);
        const bytes = yield* allocatedBytes(
          fixture.fs,
          `${fixture.config.worktreesDir}/repository/orphan-0/file`,
        );
        expect(report.entries.every((entry) => entry.bytes === bytes)).toBe(true);
        expect(report.omittedCount).toBe(5);
        expect(report.counts).toEqual({ removed: 0, kept: 205, failed: 0 });
        expect(report.bytesFreed).toBe(0);
      }),
    ),
  );
});

describe("storage cleanup reports and local file policies", () => {
  it.effect("automatically removes an eligible archived thread checkout", () =>
    runCleanupTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture();
        fixture.setThreads([
          shell({
            branch: "feature",
            worktreePath: fixture.worktree,
            archivedAt: at(-DAY_MS),
          }),
        ]);
        yield* fixture.activate(Stream.empty);
        const [report] = yield* fixture.service.reports.pipe(
          Stream.filter((report) => report !== null),
          Stream.take(1),
          Stream.runCollect,
        );
        yield* fixture.service.drain;
        expect(report).toMatchObject({
          trigger: "automatic",
          counts: { removed: 1, kept: 0, failed: 0 },
          entries: [
            {
              threadId: "thread-1",
              path: fixture.worktree,
              outcome: "removed",
              reason: "Inactive for 30 days",
            },
          ],
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }),
    ),
  );
  it.live.each(["before-check", "while-measuring"] as const)(
    "keeps a worktree protected by a missing project root (%s)",
    (timing) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* pausedMeasurementFixture();
          if (timing === "before-check")
            fixture.setProjectRoots([fixture.repo, `${fixture.worktree}/removed-checkout`]);
          const cleanup = yield* fixture.service.runNow.pipe(Effect.forkChild);
          if (timing === "while-measuring") {
            yield* Deferred.await(fixture.measuring);
            fixture.setProjectRoots([fixture.repo, `${fixture.worktree}/removed-checkout`]);
          }
          yield* Deferred.succeed(fixture.resume, undefined);
          const report = yield* Fiber.join(cleanup);
          expect(report.entries[0]).toMatchObject({
            outcome: "kept",
            reason: "Contains a project checkout",
          });
          expect(yield* fixture.fs.readFileString(`${fixture.worktree}/tracked.txt`)).toBe(
            "original\n",
          );
        }),
      ),
  );

  it.live("reports allocated bytes of single-link files without following symlinks", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setPolicy } = yield* cleanupFixture();
        setPolicy("tracked-changes");
        const sizes = yield* Effect.forEach(yield* fs.readDirectory(worktree), (name) =>
          allocatedBytes(fs, `${worktree}/${name}`),
        );
        const outside = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(`${outside}/external`, "must not count");
        yield* fs.writeFileString(`${outside}/store-file`, "shared ".repeat(10_000));
        yield* fs.makeDirectory(`${worktree}/node_modules/nested`, { recursive: true });
        yield* fs.writeFileString(`${worktree}/node_modules/nested/file`, "count me");
        sizes.push(yield* allocatedBytes(fs, `${worktree}/node_modules/nested/file`));
        yield* fs.link(`${outside}/store-file`, `${worktree}/node_modules/hardlinked`);
        yield* fs.symlink(outside, `${worktree}/node_modules/directory-link`);
        yield* fs.symlink(`${outside}/external`, `${worktree}/node_modules/file-link`);
        yield* fs.symlink(`${outside}/missing`, `${worktree}/node_modules/dangling-link`);
        const report = yield* service.runNow;
        const bytes = sizes.reduce((sum, size) => sum + size, 0);
        expect(report.entries[0]).toMatchObject({ outcome: "removed", bytes, files: null });
        expect(report.bytesFreed).toBe(bytes);
        expect(yield* fs.readFileString(`${outside}/external`)).toBe("must not count");
        expect(yield* fs.readFileString(`${outside}/store-file`)).toBe("shared ".repeat(10_000));
        expect(yield* fs.exists(worktree)).toBe(false);
      }),
    ),
  );
  it.live("falls back to file lengths when link counts and allocated blocks are unavailable", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { service, worktree } = yield* cleanupFixture().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            stat: (path) =>
              fs
                .stat(path)
                .pipe(
                  Effect.map((stat) => ({ ...stat, nlink: Option.none(), blocks: Option.none() })),
                ),
          }),
        );
        const sizes = yield* Effect.forEach(yield* fs.readDirectory(worktree), (name) =>
          fs.stat(`${worktree}/${name}`).pipe(Effect.map((stat) => Number(stat.size))),
        );
        const bytes = sizes.reduce((sum, size) => sum + size, 0);
        const report = yield* service.runNow;
        expect(report.entries[0]).toMatchObject({ outcome: "removed", bytes });
        expect(report.bytesFreed).toBe(bytes);
        expect(yield* fs.exists(worktree)).toBe(false);
      }),
    ),
  );
  it.live("still removes a worktree when measuring its size fails", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { service, worktree } = yield* cleanupFixture().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (directory) => fs.readDirectory(`${directory}/missing-directory`),
          }),
        );
        const report = yield* service.runNow;
        expect(report.entries[0]).toMatchObject({ outcome: "removed", bytes: null, files: null });
        expect(report.bytesFreed).toBe(0);
        expect(yield* fs.exists(worktree)).toBe(false);
      }),
    ),
  );
  it.live.each([
    [
      "its owner's branch is cleared",
      (worktree: string) => [shell({ branch: null, worktreePath: worktree, updatedAt: at(0) })],
    ],
    [
      "its owner's branch changes",
      (worktree: string) => [shell({ branch: "other", worktreePath: worktree, updatedAt: at(0) })],
    ],
    [
      "its thread starts",
      (worktree: string) => [
        shell({ branch: "feature", worktreePath: worktree, status: "running" }),
      ],
    ],
    [
      "another thread starts using it",
      (worktree: string) => [
        shell({ branch: "feature", worktreePath: worktree }),
        shell({ id: ThreadId.make("thread-2"), branch: "feature", worktreePath: worktree }),
      ],
    ],
    [
      "an archived thread starts using it",
      (worktree: string) => [
        shell({ branch: "feature", worktreePath: worktree }),
        shell({
          id: ThreadId.make("thread-2"),
          branch: "feature",
          worktreePath: worktree,
          archivedAt: at(-DAY_MS),
        }),
      ],
    ],
  ] as const)("keeps a worktree when %s during size measurement", ([, threadsWhileMeasuring]) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* pausedMeasurementFixture();
        const { fs, worktree } = fixture;
        fixture.setPolicy("tracked-changes");
        yield* fs.writeFileString(`${worktree}/notes.txt`, "untracked\n");
        const cleanup = yield* fixture.service.runNow.pipe(Effect.forkChild);
        yield* Deferred.await(fixture.measuring);
        fixture.setThreads(threadsWhileMeasuring(worktree));
        yield* Deferred.succeed(fixture.resume, undefined);
        const report = yield* Fiber.join(cleanup);
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Thread activity or shared worktree changed since check",
          bytes: null,
        });
        expect(report.bytesFreed).toBe(0);
        expect(yield* fs.exists(worktree)).toBe(true);
        expect(yield* fs.readFileString(`${worktree}/notes.txt`)).toBe("untracked\n");
      }),
    ),
  );
  it.live("reads the thread snapshot once per sweep, not per worktree", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, snapshotReads } = yield* cleanupFixture();
        expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "removed" });
        expect(snapshotReads()).toBe(1);
      }),
    ),
  );
  it.live.each([
    ["running", "ready", 1],
    ["stopped", "error", 2],
  ] as const)(
    "session updates to %s or %s during a sweep make %i sweep(s) in total",
    ([first, second, sweeps]) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* pausedMeasurementFixture();
          const handled = yield* Deferred.make<void>();
          yield* fixture.activate(
            Stream.fromEffect(Deferred.await(fixture.measuring)).pipe(
              Stream.flatMap(() => Stream.range(0, 19)),
              Stream.map((index) => sessionUpdated(index, index % 2 === 0 ? first : second)),
              Stream.concat(
                Stream.fromEffect(Deferred.succeed(handled, undefined)).pipe(Stream.drain),
              ),
            ),
          );
          yield* Deferred.await(handled);
          yield* Deferred.succeed(fixture.resume, undefined);
          yield* fixture.service.drain;
          expect(fixture.snapshotReads()).toBe(sweeps);
        }),
      ),
  );
  it.live("does not measure a worktree kept for an open provider session", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const walked: Array<string> = [];
        const fixture = yield* cleanupFixture().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (directory, options) => {
              walked.push(directory);
              return fs.readDirectory(directory, options);
            },
          }),
        );
        const root = yield* fs.realPath(fixture.worktree);
        fixture.setOpenSessionCwd(fixture.worktree);
        const kept = yield* fixture.service.runNow;
        expect(kept.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Provider session is still open",
          bytes: null,
        });
        expect(walked.filter((directory) => directory.startsWith(root))).toEqual([]);
        fixture.setSessionLive(false);
        const removed = yield* fixture.service.runNow;
        expect(removed.entries[0]).toMatchObject({ outcome: "removed" });
        expect(removed.entries[0]?.bytes).toBeGreaterThan(0);
        expect(walked).toContain(root);
      }),
    ),
  );
  it.live("compares the checked-out branch without a full status", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, command, setThreads, fullStatusCalls } =
          yield* cleanupFixture();
        const changed = { outcome: "kept", reason: "Repository or branch changed" };
        yield* command(worktree, ["checkout", "--detach"]);
        expect((yield* service.runNow).entries[0]).toMatchObject(changed);
        yield* command(worktree, ["switch", "--orphan", "other"]);
        expect((yield* service.runNow).entries[0]).toMatchObject(changed);
        yield* command(worktree, ["switch", "-c", "(feature)", "feature"]);
        setThreads([shell({ branch: "(feature)", worktreePath: worktree })]);
        expect((yield* service.runNow).entries[0]).toMatchObject(changed);
        setThreads([shell({ branch: "feature", worktreePath: worktree })]);
        yield* command(worktree, ["tag", "feature", "feature"]);
        // Newer Git refuses to create a tag named HEAD, but still reads one.
        yield* command(worktree, ["update-ref", "refs/tags/HEAD", "refs/heads/feature"]);
        yield* command(worktree, ["switch", "feature"]);
        const index = (yield* command(worktree, ["rev-parse", "--git-path", "index"])).stdout;
        yield* fs.writeFileString(`${index.trim()}.lock`, "");
        const locked = (yield* service.runNow).entries[0];
        expect(locked).toMatchObject({ outcome: "failed" });
        expect(locked?.reason).toContain("Git index is locked");
        yield* fs.remove(`${index.trim()}.lock`);
        const gitFile = yield* fs.readFileString(`${worktree}/.git`);
        yield* fs.writeFileString(`${worktree}/.git`, "gitdir: /missing-git-directory\n");
        expect((yield* service.runNow).entries[0]).toMatchObject(changed);
        yield* fs.writeFileString(`${worktree}/.git`, gitFile);
        expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "removed" });
        expect(fullStatusCalls()).toBe(0);
      }),
    ),
  );
  it("decodes reports from servers without size fields", () => {
    const report = decodeCleanupReport({
      trigger: "manual",
      startedAt: "2026-06-10T12:00:00.000Z",
      finishedAt: "2026-06-10T12:00:01.000Z",
      entries: [
        {
          kind: "worktree",
          outcome: "removed",
          reason: "Removed",
          path: null,
          threadId: null,
          threadTitle: null,
        },
      ],
      counts: { removed: 1, kept: 0, failed: 0 },
      omittedCount: 0,
    });
    expect(report.bytesFreed).toBe(0);
    expect(report.entries[0]).toMatchObject({ bytes: null, files: null });
  });
  it.live.each([
    ["any-local-files", ".env", "kept"],
    ["uncommitted-changes", ".env", "removed"],
    ["tracked-changes", ".env", "removed"],
    ["any-local-files", "notes.txt", "kept"],
    ["uncommitted-changes", "notes.txt", "kept"],
    ["tracked-changes", "notes.txt", "removed"],
    ["any-local-files", "tracked.txt", "kept"],
    ["uncommitted-changes", "tracked.txt", "kept"],
    ["tracked-changes", "tracked.txt", "kept"],
  ] as const)("applies %j", ([policy, file, outcome]) =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setPolicy } = yield* cleanupFixture();
        setPolicy(policy);
        expect(yield* service.latestReport).toBeNull();
        yield* fs.writeFileString(`${worktree}/${file}`, "local data\n");
        const sizes = yield* Effect.forEach(yield* fs.readDirectory(worktree), (name) =>
          allocatedBytes(fs, `${worktree}/${name}`),
        );
        const bytes = sizes.reduce((sum, size) => sum + size, 0);
        const report = yield* service.runNow;
        yield* service.drain;
        expect(report.trigger).toBe("manual");
        expect(report.entries.filter((entry) => entry.kind === "worktree")).toMatchObject([
          {
            outcome,
            path: worktree,
            threadId: "thread-1",
            threadTitle: "Thread",
            bytes: outcome === "removed" ? bytes : null,
            files: null,
          },
        ]);
        expect(report.bytesFreed).toBe(outcome === "removed" ? bytes : 0);
        expect(yield* fs.exists(worktree)).toBe(outcome === "kept");
        expect(yield* service.latestReport).toEqual(report);
        if (outcome === "kept")
          expect(report.entries[0]?.reason).toContain(
            file === ".env" ? "ignored files (.env)" : "uncommitted changes (1 file)",
          );
      }),
    ),
  );
  it.live(
    "discovers trunk without a remote HEAD or tracking ref and removes an integrated worktree",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const { service, fs, repo, worktree, command } = yield* cleanupFixture({
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            worktreeUnchanged: true,
          });
          const remote = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-remote-" });
          yield* command(remote, ["init", "--bare", "-b", "trunk"]);
          yield* command(repo, ["remote", "add", "origin", remote]);
          yield* command(repo, ["push", "origin", "main:trunk"]);
          yield* command(repo, ["update-ref", "-d", "refs/remotes/origin/trunk"]);
          expect((yield* command(repo, ["for-each-ref", "refs/remotes/origin"])).stdout).toBe("");

          const report = yield* service.runNow;
          expect(report.entries[0]).toMatchObject({
            outcome: "removed",
            reason: "No commits beyond the default branch",
          });
          expect(yield* fs.exists(worktree)).toBe(false);
        }),
      ),
  );
  it.live(
    "keeps worktree commits present on nondefault main but absent from advertised trunk",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const { service, fs, repo, worktree, command } = yield* cleanupFixture({
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            worktreeUnchanged: true,
          });
          const remote = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-remote-" });
          yield* command(remote, ["init", "--bare", "-b", "trunk"]);
          yield* command(repo, ["remote", "add", "origin", remote]);
          yield* command(repo, ["push", "origin", "main:trunk"]);
          yield* fs.writeFileString(`${worktree}/tracked.txt`, "unmerged work\n");
          yield* command(worktree, ["commit", "-am", "unmerged work"]);
          yield* command(repo, ["push", "origin", "feature:main"]);
          expect(
            (yield* command(repo, ["symbolic-ref", "refs/remotes/origin/HEAD"]).pipe(Effect.exit))
              ._tag,
          ).toBe("Failure");

          const report = yield* service.runNow;
          expect(report.entries[0]).toMatchObject({
            outcome: "kept",
            reason: "Has commits beyond the default branch",
          });
          expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe("unmerged work\n");
        }),
      ),
  );
  it.live("keeps the worktree when the remote default is unavailable even if main exists", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, repo, worktree, command } = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeUnchanged: true,
        });
        const remote = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-remote-" });
        yield* command(remote, ["init", "--bare", "-b", "trunk"]);
        yield* command(repo, ["remote", "add", "origin", remote]);
        // The remote HEAD names an unborn trunk; main exists but is not its default.
        yield* command(repo, ["push", "origin", "main"]);

        const report = yield* service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Default branch is unavailable",
        });
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );
  it.live("preserves tracked edits written after the final status check", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setPolicy("tracked-changes");
        fixture.editBeforeRemoval();
        yield* fixture.fs.writeFileString(`${fixture.worktree}/notes.txt`, "untracked\n");
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({ outcome: "failed", bytes: null, files: null });
        expect(report.bytesFreed).toBe(0);
        expect(report.entries[0]?.reason).toContain("contains modified or untracked files");
        expect(yield* fixture.fs.readFileString(`${fixture.worktree}/tracked.txt`)).toBe(
          "late edit\n",
        );
        expect(yield* fixture.fs.exists(`${fixture.worktree}/notes.txt`)).toBe(false);
      }),
    ),
  );
  it.live("streams the current report and subsequent runs", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service } = yield* cleanupFixture();
        const reports = yield* service.reports.pipe(
          Stream.take(2),
          Stream.tap((report) => (report === null ? service.runNow : Effect.void)),
          Stream.runCollect,
        );
        expect(reports[0]).toBeNull();
        expect(reports[1]).toEqual(yield* service.latestReport);
        expect(reports[1]?.counts).toEqual({ removed: 1, kept: 0, failed: 0 });
      }),
    ),
  );
  it.live("caps entries while preserving totals and prioritizing removals", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setThreads } = yield* cleanupFixture();
        const threads = [];
        for (let i = 0; i < 205; i++) {
          const worktreePath = `${worktree}-${i}`;
          yield* fs.makeDirectory(worktreePath);
          threads.push(
            shell({
              id: ThreadId.make(`thread-${i + 2}`),
              branch: "feature",
              worktreePath,
              status: "running",
            }),
          );
        }
        threads.push(shell({ branch: "feature", worktreePath: worktree }));
        setThreads(threads);
        const report = yield* service.runNow;
        expect(report.entries).toHaveLength(200);
        expect(report.omittedCount).toBe(6);
        expect(report.counts).toEqual({ removed: 1, kept: 205, failed: 0 });
        expect(report.entries[0]?.outcome).toBe("removed");
        expect(report.entries[0]?.bytes).toBeGreaterThan(0);
        expect(report.bytesFreed).toBe(report.entries[0]?.bytes);
      }),
    ),
  );
  it.live("keeps staged edits in tracked-only mode", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setPolicy, command } = yield* cleanupFixture();
        setPolicy("tracked-changes");
        yield* fs.writeFileString(`${worktree}/tracked.txt`, "staged\n");
        yield* command(worktree, ["add", "tracked.txt"]);
        expect((yield* service.runNow).entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Has uncommitted changes (1 file)",
        });
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );
  it.live(
    "reports shared and running worktrees but omits disabled rules and missing directories",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          const { service, fs, worktree, setThreads } = fixture;
          setThreads([shell({ branch: "feature", worktreePath: worktree, status: "running" })]);
          expect((yield* service.runNow).entries[0]?.reason).toContain("Thread is running");
          setThreads([
            shell({ branch: "feature", worktreePath: worktree }),
            shell({ id: ThreadId.make("thread-2"), branch: "feature", worktreePath: worktree }),
          ]);
          expect((yield* service.runNow).entries[0]?.reason).toBe("Shared by 2 threads");
          setThreads([
            shell({ branch: "feature", worktreePath: worktree }),
            shell({
              id: ThreadId.make("thread-2"),
              branch: "feature",
              worktreePath: worktree,
              archivedAt: at(-DAY_MS),
            }),
          ]);
          expect((yield* service.runNow).entries[0]?.reason).toBe("Shared by 2 threads");
          expect(yield* fs.exists(worktree)).toBe(true);
          fixture.disable();
          expect((yield* service.runNow).entries).toEqual([]);
          yield* fs.remove(worktree, { recursive: true });
          expect(
            (yield* service.runNow).entries.filter((entry) => entry.kind === "worktree"),
          ).toEqual([]);
        }),
      ),
  );
  it.live("serializes concurrent requests and returns each run's report", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service } = yield* cleanupFixture();
        const reports = yield* Effect.all([service.runNow, service.runNow], {
          concurrency: "unbounded",
        });
        yield* service.drain;
        expect(
          reports.flatMap((report) => report.entries).filter((entry) => entry.kind === "worktree"),
        ).toMatchObject([{ outcome: "removed" }]);
        expect(yield* service.latestReport).toEqual(reports[1]);
      }),
    ),
  );
  it.live("aggregates expired artifacts and rotated logs while retaining current logs", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, config, enableFiles, disable } = yield* cleanupFixture();
        disable();
        enableFiles();
        yield* fs.makeDirectory(config.browserArtifactsDir, { recursive: true });
        yield* fs.makeDirectory(config.logsDir, { recursive: true });
        for (const name of ["one.png", "two.webm"]) {
          const file = config.browserArtifactsDir + "/" + name;
          yield* fs.writeFileString(file, "capture");
          yield* fs.utimes(file, 1, 1);
        }
        for (const name of ["server.log.1", "server.log.2", "server.log"]) {
          const file = config.logsDir + "/" + name;
          yield* fs.writeFileString(file, "log");
          yield* fs.utimes(file, 1, 1);
        }
        const report = yield* service.runNow;
        expect(report.entries.filter((entry) => entry.kind !== "worktree")).toMatchObject([
          {
            kind: "browser-artifacts",
            outcome: "removed",
            reason: "Removed 2 browser artifacts",
            bytes: 14,
            files: 2,
          },
          {
            kind: "logs",
            outcome: "removed",
            reason: "Removed 2 rotated logs",
            bytes: 6,
            files: 2,
          },
        ]);
        expect(report.bytesFreed).toBe(20);
        expect(yield* fs.readDirectory(config.browserArtifactsDir)).toEqual([]);
        expect(yield* fs.exists(config.logsDir + "/server.log")).toBe(true);
        expect(yield* fs.exists(config.logsDir + "/server.log.1")).toBe(false);
        expect(yield* fs.exists(config.logsDir + "/server.log.2")).toBe(false);
      }),
    ),
  );
  it.live("reports git failures without aborting the remaining categories", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, worktree, command, enableFiles } = yield* cleanupFixture();
        enableFiles();
        yield* command(worktree, ["worktree", "lock", worktree]);
        const report = yield* service.runNow;
        expect(report.entries[0]).toMatchObject({ outcome: "failed" });
        expect(report.entries[0]?.reason).toContain("git worktree remove: fatal:");
        expect(report.entries.map((entry) => entry.kind)).toEqual([
          "worktree",
          "browser-artifacts",
          "logs",
        ]);
      }),
    ),
  );
});

describe("settled worktree retention", () => {
  it.effect.each([
    "immediate",
    "settle-script",
    "expired",
    "boundary",
    "wait",
    "recent-update",
    "active",
    "dirty",
    "project-off",
    "project-custom",
    "inactive-settling",
  ] as const)("applies retention and safety checks (%s)", (scenario) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture();
      const days = ["wait", "boundary", "expired", "recent-update"].includes(scenario) ? 8 : 0;
      const rules = {
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeSettledAfterDays:
          scenario === "project-custom" || scenario === "inactive-settling" ? null : days,
        worktreeAfterDays: scenario === "inactive-settling" ? 1 : null,
      };
      fixture.setSettings({
        storageCleanup: rules,
        projectSettingsOverrides: {
          [ProjectId.make("project-1")]:
            scenario === "project-off"
              ? { worktreeCleanup: { mode: "off" } }
              : scenario === "project-custom"
                ? {
                    worktreeCleanup: {
                      mode: "custom",
                      rules: { ...rules, worktreeSettledAfterDays: 0 },
                    },
                  }
                : {},
        },
      });
      const thread = shell({
        branch: "feature",
        worktreePath: fixture.worktree,
        settledAt:
          scenario === "active"
            ? null
            : at(
                scenario === "expired" ||
                  scenario === "recent-update" ||
                  scenario === "inactive-settling"
                  ? -20 * DAY_MS
                  : scenario === "boundary"
                    ? -8 * DAY_MS
                    : scenario === "wait"
                      ? -8 * DAY_MS + 1
                      : scenario === "settle-script"
                        ? 0
                        : -60_000,
              ),
        updatedAt: at(
          scenario === "recent-update" ||
            scenario === "settle-script" ||
            scenario === "inactive-settling"
            ? 0
            : -10 * DAY_MS,
        ),
      });
      fixture.setThreads([thread]);
      if (scenario === "dirty")
        yield* fixture.fs.writeFileString(`${fixture.worktree}/tracked.txt`, "edit\n");
      const report = yield* fixture.service.runNow;
      const removed = ["immediate", "expired", "boundary", "project-custom"].includes(scenario);
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(!removed);
      expect(report.counts.removed).toBe(removed ? 1 : 0);
      if (scenario !== "project-off") {
        const reason =
          scenario === "active"
            ? "Not settled"
            : scenario === "wait"
              ? "Settled for 7 of 8 days"
              : ["settle-script", "recent-update", "inactive-settling"].includes(scenario)
                ? "Settled moments ago"
                : scenario === "dirty"
                  ? "Has uncommitted changes (1 file)"
                  : `Settled for ${scenario === "expired" ? 20 : scenario === "boundary" ? 8 : 0} days`;
        expect(report.entries[0]).toMatchObject({ outcome: removed ? "removed" : "kept", reason });
      }
      expect(thread.branch).toBe("feature");
      expect(
        (yield* fixture.command(fixture.repo, ["rev-parse", "--verify", "refs/heads/feature"]))
          .exitCode,
      ).toBe(0);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );
});

describe("settled worktree rechecks", () => {
  it.live.each([{ settledAt: null }, { settledAt: at(DAY_MS) }])(
    "keeps a checkout changed during measurement (%j)",
    (change) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* pausedMeasurementFixture();
          const thread = shell({
            branch: "feature",
            worktreePath: fixture.worktree,
            settledAt: at(0),
          });
          fixture.setSettings({
            storageCleanup: {
              ...DEFAULT_SERVER_SETTINGS.storageCleanup,
              worktreeSettledAfterDays: 0,
            },
          });
          fixture.setThreads([thread]);
          const run = yield* fixture.service.runNow.pipe(Effect.forkChild);
          yield* Deferred.await(fixture.measuring);
          fixture.setThreads([{ ...thread, ...change }]);
          yield* Deferred.succeed(fixture.resume, undefined);
          const report = yield* Fiber.join(run);
          expect(report.entries[0]?.reason).toBe(
            "Thread activity or shared worktree changed since check",
          );
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );
});

it.live("keeps saved usage data when removing a settled checkout", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* cleanupFixture();
      fixture.setSettings({
        storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, worktreeSettledAfterDays: 0 },
      });
      fixture.setThreads([
        shell({ branch: "feature", worktreePath: fixture.worktree, settledAt: at(0) }),
      ]);
      yield* fixture.fs.makeDirectory(fixture.config.stateDir, { recursive: true });
      const cachePath = `${fixture.config.stateDir}/${SCAN_CACHE_FILE_NAME}`;
      const savedUsage = JSON.stringify({ tokens: 12345, cost: 1.25 });
      yield* fixture.fs.writeFileString(cachePath, savedUsage);
      expect((yield* fixture.service.runNow).counts.removed).toBe(1);
      expect(yield* fixture.fs.readFileString(cachePath)).toBe(savedUsage);
    }),
  ),
);

it.live.each(["thread.settled", "stopped", "ready"] as const)(
  "leaves settled cleanup to the regular sweeps after %s",
  (trigger) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* pausedMeasurementFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeSettledAfterDays: 0,
        });
        fixture.setSettings({
          storageCleanup: {
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            worktreeSettledAfterDays: 0,
          },
        });
        const thread = shell({
          branch: "feature",
          worktreePath: fixture.worktree,
          settledAt: at(0),
        });
        fixture.setThreads([thread]);
        const handled = yield* Deferred.make<void>();
        yield* fixture.activate(
          Stream.fromEffect(Deferred.await(fixture.measuring)).pipe(
            Stream.flatMap(() => Stream.range(0, 19)),
            Stream.map((index): OrchestrationV2DomainEvent =>
              trigger === "thread.settled"
                ? {
                    id: EventId.make(`settled-${index}`),
                    type: "thread.settled",
                    threadId: thread.id,
                    occurredAt: at(0),
                    payload: { ...thread, lastVisitedAt: null },
                  }
                : sessionUpdated(index, trigger),
            ),
            Stream.concat(
              Stream.fromEffect(Deferred.succeed(handled, undefined)).pipe(Stream.drain),
            ),
          ),
        );
        yield* Deferred.await(handled);
        yield* Deferred.succeed(fixture.resume, undefined);
        yield* fixture.service.drain;
        expect(fixture.snapshotReads()).toBe(1);
      }),
    ),
);
