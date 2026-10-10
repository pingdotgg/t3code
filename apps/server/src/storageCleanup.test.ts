import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  DEFAULT_SERVER_SETTINGS,
  StorageCleanupReport,
  type WorktreeKeepWhen,
} from "@t3tools/contracts";
import * as ServerConfig from "./config.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Settings from "./serverSettings.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { ServerActivation } from "./serverActivation.ts";
import { describe, expect, it } from "@effect/vitest";
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

const cleanupFixture = Effect.gen(function* () {
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
    storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, worktreeAfterDays: 8 },
  };
  let threads = [shell({ branch: "feature", worktreePath: worktree })];
  let editBeforeRemoval = false;
  const context = yield* Layer.build(StorageCleanup.layer).pipe(
    Effect.provideService(GitVcsDriver.GitVcsDriver, {
      ...git,
      execute: (input) =>
        Effect.gen(function* () {
          if (editBeforeRemoval && input.args.includes("remove"))
            yield* fs.writeFileString(`${worktree}/tracked.txt`, "late edit\n");
          return yield* git.execute(input);
        }),
    }),
    Effect.provideService(Settings.ServerSettingsService, {
      getSettings: Effect.sync(() => settings),
      subscribeChanges: Effect.succeed(Stream.empty),
    } as unknown as Settings.ServerSettingsService["Service"]),
    Effect.provideService(ProjectStore.ProjectStoreV2, {
      listShells: () => Effect.succeed([{ id: ProjectId.make("project-1"), workspaceRoot: repo }]),
    } as unknown as ProjectStore.ProjectStoreV2["Service"]),
    Effect.provideService(ProjectionStore.ProjectionStoreV2, {
      getShellSnapshot: (input?: { location?: string }) =>
        Effect.sync(() => ({ threads: input?.location === "archive" ? [] : threads })),
    } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
    Effect.provideService(Orchestrator.OrchestratorV2, {
      streamDomainEvents: Stream.empty,
    } as unknown as Orchestrator.OrchestratorV2["Service"]),
    Effect.provideService(SqlClient.SqlClient, (() =>
      Effect.succeed([])) as unknown as SqlClient.SqlClient),
    Effect.provideService(GitManager.GitManager, {
      invalidateStatus: () => Effect.void,
    } as unknown as GitManager.GitManager["Service"]),
    Effect.provideService(TerminalManager.TerminalManager, {
      subscribeMetadata: () => Effect.succeed(() => {}),
    } as unknown as TerminalManager.TerminalManager["Service"]),
    Effect.provideService(ServerActivation, Effect.never),
  );
  return {
    service: Context.get(context, StorageCleanup.StorageCleanup),
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
    setPolicy: (worktreeKeepWhen: WorktreeKeepWhen) => {
      settings = { ...settings, storageCleanup: { ...settings.storageCleanup, worktreeKeepWhen } };
    },
    disable: () => {
      settings = {
        ...settings,
        storageCleanup: { ...settings.storageCleanup, worktreeAfterDays: null },
      };
    },
    setThreads: (next: typeof threads) => {
      threads = next;
    },
  };
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

describe("storage cleanup reports and local file policies", () => {
  it.live("measures nested regular files without following symlinks", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setPolicy } = yield* cleanupFixture;
        setPolicy("tracked-changes");
        const sizes = yield* Effect.forEach(yield* fs.readDirectory(worktree), (name) =>
          fs.stat(`${worktree}/${name}`).pipe(Effect.map((stat) => Number(stat.size))),
        );
        const outside = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(`${outside}/external`, "must not count");
        yield* fs.makeDirectory(`${worktree}/node_modules/nested`, { recursive: true });
        yield* fs.writeFileString(`${worktree}/node_modules/nested/file`, "count me");
        yield* fs.symlink(outside, `${worktree}/node_modules/directory-link`);
        yield* fs.symlink(`${outside}/external`, `${worktree}/node_modules/file-link`);
        yield* fs.symlink(`${outside}/missing`, `${worktree}/node_modules/dangling-link`);
        const report = yield* service.runNow;
        const bytes = sizes.reduce((sum, size) => sum + size, 8);
        expect(report.entries[0]).toMatchObject({ outcome: "removed", bytes, files: null });
        expect(report.bytesFreed).toBe(bytes);
        expect(yield* fs.readFileString(`${outside}/external`)).toBe("must not count");
      }),
    ),
  );
  it.live("still removes a worktree when measuring its size fails", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { service, worktree } = yield* cleanupFixture.pipe(
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
  it.live("keeps a worktree when its thread starts during size measurement", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const measuring = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let measuredPath: string | undefined;
        const fixture = yield* cleanupFixture.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (directory) =>
              Effect.gen(function* () {
                if (directory === measuredPath) {
                  yield* Deferred.succeed(measuring, undefined);
                  yield* Deferred.await(resume);
                }
                return yield* fs.readDirectory(directory);
              }),
          }),
        );
        measuredPath = yield* fs.realPath(fixture.worktree);
        fixture.setPolicy("tracked-changes");
        yield* fs.writeFileString(`${fixture.worktree}/notes.txt`, "untracked\n");
        const cleanup = yield* fixture.service.runNow.pipe(Effect.forkChild);
        yield* Deferred.await(measuring);
        fixture.setThreads([
          shell({ branch: "feature", worktreePath: fixture.worktree, status: "running" }),
        ]);
        yield* Deferred.succeed(resume, undefined);
        const report = yield* Fiber.join(cleanup);
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Thread activity or shared worktree changed since check",
          bytes: null,
        });
        expect(report.bytesFreed).toBe(0);
        expect(yield* fs.exists(fixture.worktree)).toBe(true);
        expect(yield* fs.readFileString(`${fixture.worktree}/notes.txt`)).toBe("untracked\n");
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
        const { service, fs, worktree, setPolicy } = yield* cleanupFixture;
        setPolicy(policy);
        expect(yield* service.latestReport).toBeNull();
        yield* fs.writeFileString(`${worktree}/${file}`, "local data\n");
        const sizes = yield* Effect.forEach(yield* fs.readDirectory(worktree), (name) =>
          fs.stat(`${worktree}/${name}`).pipe(Effect.map((stat) => Number(stat.size))),
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
  it.live("preserves tracked edits written after the final status check", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture;
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
        const { service } = yield* cleanupFixture;
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
        const { service, fs, worktree, setThreads } = yield* cleanupFixture;
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
        const { service, fs, worktree, setPolicy, command } = yield* cleanupFixture;
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
          const fixture = yield* cleanupFixture;
          const { service, fs, worktree, setThreads } = fixture;
          setThreads([shell({ branch: "feature", worktreePath: worktree, status: "running" })]);
          expect((yield* service.runNow).entries[0]?.reason).toContain("Thread is running");
          setThreads([
            shell({ branch: "feature", worktreePath: worktree }),
            shell({ id: ThreadId.make("thread-2"), branch: "feature", worktreePath: worktree }),
          ]);
          expect((yield* service.runNow).entries[0]?.reason).toBe("Shared by 2 threads");
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
        const { service } = yield* cleanupFixture;
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
        const { service, fs, config, enableFiles, disable } = yield* cleanupFixture;
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
        const { service, worktree, command, enableFiles } = yield* cleanupFixture;
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
