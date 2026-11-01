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
import { SCAN_CACHE_FILE_NAME } from "./usage/usageScanCache.ts";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import {
  DEFAULT_SERVER_SETTINGS,
  type WorktreeKeepWhen,
  type StorageCleanupSettings,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
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
    expect(storageCleanupThreadIdle(candidate(), NOW_MS, DEFAULT_SERVER_SETTINGS)).toBe(true);
    expect(storageCleanupThreadIdle(shell(), NOW_MS, DEFAULT_SERVER_SETTINGS)).toBe(false);
  });

  it.each(["running", "starting", "preparing", "waiting", "queued"] as const)(
    "retains a worktree while its thread is %s",
    (status) => {
      expect(
        storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS, DEFAULT_SERVER_SETTINGS),
      ).toBe(false);
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
          DEFAULT_SERVER_SETTINGS,
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
          DEFAULT_SERVER_SETTINGS,
        ),
      ).toBe(false);
    },
  );

  it("retains an active run even if the shell status is idle", () => {
    expect(
      storageCleanupThreadIdle(
        { ...candidate(), activeRunId: RunId.make("run") },
        NOW_MS,
        DEFAULT_SERVER_SETTINGS,
      ),
    ).toBe(false);
  });

  it("retains a queued prompt before the new run has been projected", () => {
    expect(
      storageCleanupThreadIdle(
        { ...candidate(), latestUserMessageAt: at(-1_000) },
        NOW_MS,
        DEFAULT_SERVER_SETTINGS,
      ),
    ).toBe(false);
  });

  it.each([
    { name: "snoozed until a future reset", snooze: true, resetIn: DAY_MS, idle: false },
    { name: "set to auto-resume", autoResume: true, resetIn: DAY_MS, idle: false },
    { name: "with recovery turned off", resetIn: DAY_MS, idle: true },
    { name: "auto-resuming after the reset", autoResume: true, resetIn: -1_000, idle: false },
    { name: "snoozed past its reset", snooze: true, resetIn: -1_000, idle: true },
    {
      name: "settled with an auto-resume pending",
      autoResume: true,
      settled: true,
      resetIn: -1_000,
      idle: true,
    },
    { name: "not yet armed by the recovery worker", armed: false, resetIn: DAY_MS, idle: false },
    {
      name: "not yet armed, auto-resume after reset",
      armed: false,
      autoResumeSetting: true,
      resetIn: -1_000,
      idle: false,
    },
    {
      name: "not armed with recovery settings off",
      armed: false,
      settingsOff: true,
      resetIn: DAY_MS,
      idle: true,
    },
  ])(
    "treats a usage-limited thread $name as idle: $idle",
    ({
      autoResume = false,
      snooze = false,
      armed = true,
      autoResumeSetting = false,
      settled,
      settingsOff,
      resetIn,
      idle,
    }) => {
      const runId = RunId.make("run-1");
      const resetAt = DateTime.formatIso(at(resetIn));
      expect(
        storageCleanupThreadIdle(
          {
            ...candidateWithStatus("failed"),
            latestRunId: runId,
            lastErrorClass: "usage_limit",
            usageLimitResetAt: resetAt,
            settledOverride: settled ? "settled" : null,
            limitRecovery: armed ? { runId, resetAt, autoResume, snooze } : null,
          },
          NOW_MS,
          { autoResumeLimitedThreads: autoResumeSetting, snoozeLimitedThreads: !settingsOff },
        ),
      ).toBe(idle);
    },
  );

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
    const repo = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-repo-" }));
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
    let deletedThreads: OrchestrationV2ThreadShell[] = [];
    let storedWorktreePaths: string[] = [worktree];
    let projectRoots = [repo];
    let editBeforeRemoval = false;
    let openSessionCwd: string | null = null;
    let sessionLive = true;
    let onLiveCheck: Effect.Effect<void> = Effect.void;
    let outboxStatus: string | null = null;
    let fullStatusCalls = 0;
    let snapshotReads = 0;
    let terminalListener: ((event: TerminalMetadataStreamEvent) => Effect.Effect<void>) | undefined;
    let events: Stream.Stream<OrchestrationV2DomainEvent> = Stream.empty;
    const activated = yield* Deferred.make<void>();
    const context = yield* Layer.build(StorageCleanup.layer).pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, {
        ...git,
        execute: (input) =>
          Effect.gen(function* () {
            // Before Git's own clean check: inside `git worktree remove`, or on
            // Windows the same status check the removal makes before deleting.
            if (
              editBeforeRemoval &&
              (input.args.includes("remove") || input.args.includes("--porcelain"))
            )
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
        isLive: () =>
          Effect.sync(() => sessionLive).pipe(Effect.tap(() => Effect.suspend(() => onLiveCheck))),
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
            : outboxStatus !== null && strings.join("").includes("orchestration_v2_effect_outbox")
              ? [{ status: outboxStatus }]
              : strings.join("").includes("deleted_at IS NOT NULL")
                ? deletedThreads.map((thread) => ({
                    payload_json: JSON.stringify(thread),
                    workspaceRoot: repo,
                  }))
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
        subscribeMetadata: (
          listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
        ) =>
          Effect.sync(() => {
            terminalListener = listener;
            return () => {};
          }),
      } as unknown as TerminalManager.TerminalManager["Service"]),
      Effect.provideService(ServerActivation, Deferred.await(activated)),
    );
    return {
      service: Context.get(context, StorageCleanup.StorageCleanup),
      repo,
      setTerminals: (terminals: TerminalSummary[]) =>
        terminalListener?.({ type: "snapshot", terminals }) ?? Effect.void,
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
      setOnLiveCheck: (hook: Effect.Effect<void>) => {
        onLiveCheck = hook;
      },
      setOutboxStatus: (status: string | null) => {
        outboxStatus = status;
      },
      setDeletedThreads: (next: OrchestrationV2ThreadShell[]) => {
        deletedThreads = next;
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
      openTerminal: (paths: { cwd: string; worktreePath: string | null }) =>
        terminalListener?.({
          type: "upsert",
          terminal: {
            threadId: "thread-1",
            terminalId: "terminal-1",
            status: "running",
            pid: 1,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: false,
            label: "Terminal",
            updatedAt: "2026-06-10T12:00:00.000Z",
            ...paths,
          },
        }) ?? Effect.void,
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

const submoduleCleanupFixture = () =>
  Effect.gen(function* () {
    const fixture = yield* cleanupFixture();
    const { command, repo, worktree } = fixture;
    const submodule = `${worktree}/module`;
    const child = `${submodule}/child`;
    for (const [cwd, name] of [
      [worktree, "module"],
      [submodule, "child"],
    ] as const) {
      yield* command(cwd, ["-c", "protocol.file.allow=always", "submodule", "add", repo, name]);
      yield* command(`${cwd}/${name}`, ["config", "user.name", "Cleanup test"]);
      yield* command(`${cwd}/${name}`, ["config", "user.email", "cleanup@example.test"]);
    }
    const recordSubmodules = () =>
      Effect.gen(function* () {
        yield* command(submodule, ["commit", "-am", "record child"]);
        yield* command(submodule, ["push", "origin", "HEAD:submodule"]);
        yield* command(worktree, ["commit", "-am", "record module"]);
      });
    yield* recordSubmodules();
    return { ...fixture, submodule, child, recordSubmodules };
  });

it.live("removes clean submodules recursively, including deinitialized repositories", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, repo, worktree, submodule, command, recordSubmodules } =
        yield* submoduleCleanupFixture();
      yield* command(submodule, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        repo,
        "stored",
      ]);
      yield* recordSubmodules();
      yield* command(submodule, ["submodule", "deinit", "stored"]);
      const admin = (yield* command(worktree, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      const report = yield* service.runNow;
      expect(report.entries.find((entry) => entry.path === worktree)).toMatchObject({
        outcome: "removed",
      });
      expect(report.counts).toEqual({ removed: 1, kept: 0, failed: 0 });
      expect(yield* fs.exists(worktree)).toBe(false);
      expect(yield* fs.exists(admin)).toBe(false);
    }),
  ),
);

it.live("keeps nested submodule files protected by the current keep rule", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree, submodule, child, command, setPolicy } =
        yield* submoduleCleanupFixture();
      setPolicy("tracked-changes");
      yield* fs.writeFileString(`${child}/tracked.txt`, "local edit\n");
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept" });
      expect(yield* fs.readFileString(`${child}/tracked.txt`)).toBe("local edit\n");
      yield* fs.writeFileString(`${child}/tracked.txt`, "original\n");
      setPolicy("any-local-files");
      yield* fs.writeFileString(`${child}/.env`, "local secret\n");
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept" });
      expect(yield* fs.readFileString(`${child}/.env`)).toBe("local secret\n");

      yield* fs.remove(`${child}/.env`);
      yield* command(submodule, ["submodule", "deinit", "child"]);
      yield* fs.writeFileString(`${child}/.env`, "secret after deinit\n");
      const report = yield* service.runNow;
      expect({
        outcome: report.entries.find((entry) => entry.path === worktree)?.outcome,
        contents: (yield* fs.exists(`${child}/.env`))
          ? yield* fs.readFileString(`${child}/.env`)
          : null,
      }).toEqual({ outcome: "kept", contents: "secret after deinit\n" });

      yield* fs.remove(`${child}/.env`);
      setPolicy("uncommitted-changes");
      yield* fs.writeFileString(`${child}/notes.txt`, "notes after deinit\n");
      const untrackedReport = yield* service.runNow;
      expect({
        outcome: untrackedReport.entries.find((entry) => entry.path === worktree)?.outcome,
        contents: (yield* fs.exists(`${child}/notes.txt`))
          ? yield* fs.readFileString(`${child}/notes.txt`)
          : null,
      }).toEqual({ outcome: "kept", contents: "notes after deinit\n" });
    }),
  ),
);

it.live("keeps unpushed submodule history after checkout and deinitialization", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree, submodule, child, command, recordSubmodules } =
        yield* submoduleCleanupFixture();
      yield* command(child, ["checkout", "-b", "local-only"]);
      yield* fs.writeFileString(`${child}/tracked.txt`, "unpublished work\n");
      yield* command(child, ["commit", "-am", "local work"]);
      const local = (yield* command(child, ["rev-parse", "HEAD"])).stdout.trim();
      yield* recordSubmodules();
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      expect(yield* fs.readFileString(`${child}/tracked.txt`)).toBe("unpublished work\n");

      yield* command(child, ["checkout", "main"]);
      yield* recordSubmodules();
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      const childGit = (yield* command(child, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      yield* command(submodule, ["submodule", "deinit", "child"]);
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      expect(
        (yield* command(worktree, [
          "--git-dir",
          childGit,
          "rev-parse",
          "refs/heads/local-only",
        ])).stdout.trim(),
      ).toBe(local);
      expect(
        (yield* command(worktree, ["--git-dir", childGit, "show", "local-only:tracked.txt"]))
          .stdout,
      ).toBe("unpublished work\n");
      yield* command(worktree, ["--git-dir", childGit, "branch", "-D", "local-only"]);
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      expect(
        (yield* command(worktree, ["--git-dir", childGit, "show", `${local}:tracked.txt`])).stdout,
      ).toBe("unpublished work\n");
    }),
  ),
);

it.live("keeps submodules when stored repository metadata is malformed", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree, submodule, child, command } = yield* submoduleCleanupFixture();
      const childGit = (yield* command(child, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      yield* command(submodule, ["submodule", "deinit", "child"]);
      yield* fs.writeFileString(`${childGit}/HEAD`, "not a ref\n");
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("inspected") });
      expect(yield* fs.exists(worktree)).toBe(true);
      expect(yield* fs.readFileString(`${childGit}/HEAD`)).toBe("not a ref\n");
    }),
  ),
);

it.live("preserves late tracked edits when submodules were never initialized", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* cleanupFixture();
      const { service, fs, worktree, command } = fixture;
      const head = (yield* command(worktree, ["rev-parse", "HEAD"])).stdout.trim();
      yield* fs.writeFileString(
        `${worktree}/.gitmodules`,
        '[submodule "module"]\n\tpath = module\n\turl = /unused\n',
      );
      yield* command(worktree, ["add", ".gitmodules"]);
      yield* command(worktree, ["update-index", "--add", "--cacheinfo", `160000,${head},module`]);
      yield* command(worktree, ["commit", "-m", "record uninitialized module"]);
      yield* fs.makeDirectory(`${worktree}/module`);
      fixture.editBeforeRemoval();
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "failed" });
      expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe("late edit\n");
    }),
  ),
);

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
    "side-chat",
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
            scenario === "fork" || scenario === "side-chat"
              ? "fork"
              : scenario === "unrelated"
                ? null
                : "subagent",
          ...(scenario === "side-chat" ? { sideChat: true } : {}),
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
      const removed = ["idle", "grandchild", "isolated-owner", "fork-owner", "side-chat"].includes(
        scenario,
      );
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

describe("deleted thread worktrees", () => {
  const parent = (worktreePath: string) =>
    shell({ branch: "feature", worktreePath, deletedAt: at(-DAY_MS) });
  // Deleting the parent leaves its native subagent thread in the projection.
  const subagent = (
    owner: OrchestrationV2ThreadShell,
    overrides: Partial<OrchestrationV2ThreadShell> = {},
  ) =>
    shell({
      id: ThreadId.make("child"),
      title: "Subagent",
      branch: "feature",
      worktreePath: owner.worktreePath,
      status: "completed",
      createdBy: "agent",
      creationSource: "provider",
      lineage: {
        rootThreadId: owner.id,
        parentThreadId: owner.id,
        relationshipToParent: "subagent",
      },
      ...overrides,
    });

  it.effect.each(["no subagents", "native subagent"] as const)(
    "removes a deleted thread's worktree with %s",
    (scenario) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeAfterDays: null,
          worktreeOnDelete: true,
        });
        const owner = parent(fixture.worktree);
        fixture.setDeletedThreads([owner]);
        fixture.setThreads(scenario === "native subagent" ? [subagent(owner)] : []);
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({
          threadId: owner.id,
          outcome: "removed",
          reason: "Thread was deleted",
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect("applies the remaining subagent's rules when deletion cleanup is off", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeAfterDays: 8,
        worktreeOnDelete: false,
      });
      const owner = parent(fixture.worktree);
      const child = subagent(owner);
      fixture.setDeletedThreads([owner]);
      fixture.setThreads([child]);
      const report = yield* fixture.service.runNow;
      expect(report.entries[0]).toMatchObject({
        threadId: child.id,
        outcome: "removed",
        reason: "Inactive for 30 days",
      });
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  // Releases one stopped-session event after the startup sweep and returns the snapshot reads it caused.
  const stopSessionAfterStartupSweep = (
    fixture: Effect.Success<ReturnType<typeof cleanupFixture>>,
    threadId: ThreadId,
    beforeStop: Effect.Effect<void> = Effect.void,
    cwd = fixture.worktree,
  ) =>
    Effect.gen(function* () {
      const startupSwept = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const stopped: OrchestrationV2DomainEvent = {
        id: EventId.make("event:session-stopped"),
        type: "provider-session.updated",
        threadId,
        occurredAt: at(0),
        payload: {
          id: ProviderSessionId.make("session-1"),
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "stopped",
          cwd,
          model: null,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: at(-DAY_MS),
          updatedAt: at(0),
          lastError: null,
        },
      };
      yield* fixture.activate(
        Stream.fromEffect(Deferred.await(startupSwept)).pipe(
          Stream.flatMap(() => Stream.make(stopped)),
          Stream.concat(
            Stream.fromEffect(Deferred.succeed(delivered, undefined)).pipe(Stream.drain),
          ),
        ),
      );
      yield* fixture.service.reports.pipe(
        Stream.filter((report) => report !== null),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* fixture.service.drain;
      yield* beforeStop;
      const readsBefore = fixture.snapshotReads();
      yield* Deferred.succeed(startupSwept, undefined);
      yield* Deferred.await(delivered);
      yield* fixture.service.drain;
      return fixture.snapshotReads() - readsBefore;
    });

  it.effect("does not sweep when a live thread's session stops and no deleted worktree waits", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture();
      const reads = yield* stopSessionAfterStartupSweep(fixture, ThreadId.make("thread-1"));
      expect(reads, "a live thread's stopped session re-read every thread").toBe(0);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect("removes a deleted thread's worktree once its session stops", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeAfterDays: null,
        worktreeOnDelete: true,
      });
      const owner = parent(fixture.worktree);
      fixture.setDeletedThreads([owner]);
      fixture.setThreads([]);
      fixture.setOpenSessionCwd(fixture.worktree);
      const reads = yield* stopSessionAfterStartupSweep(
        fixture,
        owner.id,
        Effect.sync(() => fixture.setSessionLive(false)),
      );
      expect(reads).toBeGreaterThan(0);
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect("removes a deleted thread's worktree once a live thread's session in it stops", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeAfterDays: null,
        worktreeOnDelete: true,
      });
      const owner = parent(fixture.worktree);
      const child = subagent(owner);
      fixture.setDeletedThreads([owner]);
      fixture.setThreads([child]);
      fixture.setOpenSessionCwd(fixture.worktree);
      const reads = yield* stopSessionAfterStartupSweep(
        fixture,
        child.id,
        Effect.gen(function* () {
          expect((yield* fixture.service.latestReport)?.entries[0]).toMatchObject({
            threadId: owner.id,
            outcome: "kept",
            reason: "Provider session is still open",
          });
          fixture.setSessionLive(false);
        }),
      );
      expect(reads).toBeGreaterThan(0);
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect(
    "removes a deleted thread's worktree once its terminal closes and its session stops",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeAfterDays: null,
          worktreeOnDelete: true,
        });
        const owner = parent(fixture.worktree);
        fixture.setDeletedThreads([owner]);
        fixture.setThreads([]);
        yield* fixture.setTerminals([
          {
            threadId: owner.id,
            terminalId: "terminal-1",
            cwd: fixture.worktree,
            worktreePath: fixture.worktree,
            status: "running",
            pid: 1,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: false,
            label: "Terminal",
            updatedAt: DateTime.formatIso(at(0)),
          },
        ]);
        const reads = yield* stopSessionAfterStartupSweep(
          fixture,
          owner.id,
          Effect.gen(function* () {
            expect((yield* fixture.service.latestReport)?.entries[0]).toMatchObject({
              threadId: owner.id,
              outcome: "kept",
              reason: "Open terminal",
            });
            yield* fixture.setTerminals([]);
          }),
          fixture.repo,
        );
        expect(reads).toBeGreaterThan(0);
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect(
    "retries a deleted thread's worktree kept for another reason when a session in it stops",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeAfterDays: null,
          worktreeOnDelete: true,
        });
        const owner = parent(fixture.worktree);
        fixture.setDeletedThreads([owner]);
        fixture.setThreads([]);
        yield* fixture.fs.writeFileString(`${fixture.worktree}/tracked.txt`, "agent edit\n");
        const reads = yield* stopSessionAfterStartupSweep(
          fixture,
          owner.id,
          Effect.gen(function* () {
            expect((yield* fixture.service.latestReport)?.entries[0]).toMatchObject({
              threadId: owner.id,
              outcome: "kept",
              reason: "Has uncommitted changes (1 file)",
            });
            yield* fixture.fs
              .writeFileString(`${fixture.worktree}/tracked.txt`, "original\n")
              .pipe(Effect.orDie);
          }),
        );
        expect(reads).toBeGreaterThan(0);
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect("does not sweep for a kept deleted worktree when a session elsewhere stops", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeAfterDays: null,
        worktreeOnDelete: true,
      });
      fixture.setDeletedThreads([parent(fixture.worktree)]);
      fixture.setThreads([]);
      yield* fixture.fs.writeFileString(`${fixture.worktree}/tracked.txt`, "agent edit\n");
      const reads = yield* stopSessionAfterStartupSweep(
        fixture,
        ThreadId.make("thread-elsewhere"),
        Effect.void,
        fixture.repo,
      );
      expect(reads).toBe(0);
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect(
    "does not sweep for a deleted thread whose cleanup effect failed when a session elsewhere stops",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeAfterDays: null,
          worktreeOnDelete: true,
        });
        const owner = parent(fixture.worktree);
        fixture.setDeletedThreads([owner]);
        fixture.setThreads([]);
        fixture.setOutboxStatus("failed");
        const reads = yield* stopSessionAfterStartupSweep(
          fixture,
          ThreadId.make("thread-elsewhere"),
          Effect.gen(function* () {
            expect((yield* fixture.service.latestReport)?.entries[0]).toMatchObject({
              threadId: owner.id,
              outcome: "kept",
              reason: "Thread deletion is still pending",
            });
          }),
          fixture.repo,
        );
        expect(reads).toBe(0);
      }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect(
    "removes a deleted thread's worktree when its session stops during the deletion's sweep",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeAfterDays: null,
          worktreeOnDelete: true,
        });
        const owner = parent(fixture.worktree);
        fixture.setThreads([]);
        const startupSwept = yield* Deferred.make<void>();
        const sessionChecked = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<void>();
        const deleted = {
          id: EventId.make("event:thread-deleted"),
          type: "thread.deleted",
          threadId: owner.id,
          occurredAt: at(0),
          payload: owner,
        } as unknown as OrchestrationV2DomainEvent;
        const stopped: OrchestrationV2DomainEvent = {
          id: EventId.make("event:session-stopped"),
          type: "provider-session.updated",
          threadId: owner.id,
          occurredAt: at(0),
          payload: {
            id: ProviderSessionId.make("session-1"),
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            status: "stopped",
            cwd: fixture.worktree,
            model: null,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: at(-DAY_MS),
            updatedAt: at(0),
            lastError: null,
          },
        };
        yield* fixture.activate(
          Stream.fromEffect(Deferred.await(startupSwept)).pipe(
            Stream.flatMap(() => Stream.make(deleted)),
            Stream.concat(Stream.fromEffect(Deferred.await(sessionChecked)).pipe(Stream.drain)),
            Stream.concat(Stream.make(stopped)),
            Stream.concat(
              Stream.fromEffect(Deferred.succeed(delivered, undefined)).pipe(Stream.drain),
            ),
          ),
        );
        yield* fixture.service.reports.pipe(
          Stream.filter((report) => report !== null),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* fixture.service.drain;
        fixture.setDeletedThreads([owner]);
        fixture.setOpenSessionCwd(fixture.worktree);
        // The deletion's sweep sees the session live; it stops before that sweep publishes its result.
        fixture.setOnLiveCheck(
          Effect.gen(function* () {
            fixture.setOnLiveCheck(Effect.void);
            yield* Deferred.succeed(sessionChecked, undefined);
            yield* Deferred.await(delivered);
            fixture.setSessionLive(false);
          }),
        );
        yield* Deferred.succeed(startupSwept, undefined);
        yield* Deferred.await(delivered);
        yield* fixture.service.drain;
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect("waits out the settle grace of a subagent that just settled", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeAfterDays: null,
        worktreeOnDelete: true,
      });
      const owner = parent(fixture.worktree);
      fixture.setDeletedThreads([owner]);
      fixture.setThreads([subagent(owner, { settledAt: at(0), updatedAt: at(0) })]);
      const report = yield* fixture.service.runNow;
      expect(report.entries[0]).toMatchObject({
        threadId: owner.id,
        outcome: "kept",
        reason: "Settled moments ago",
      });
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
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
              projectPath: null,
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

  it.live.each([
    ["win32", "cwd"],
    ["win32", "worktreePath"],
    ["linux", "cwd"],
    ["linux", "worktreePath"],
  ] as const)(
    "matches a terminal at the worktree root with host casing rules (%s, %s)",
    ([platform, field]) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture().pipe(
            Effect.provideService(HostProcess.Platform, platform),
          );
          const upper = fixture.worktree.toUpperCase();
          yield* fixture.openTerminal(
            field === "cwd"
              ? { cwd: upper, worktreePath: null }
              : { cwd: fixture.repo, worktreePath: upper },
          );
          const report = yield* fixture.service.runNow;
          expect(report.entries[0]).toMatchObject(
            platform === "win32"
              ? { outcome: "kept", reason: "Open terminal" }
              : { outcome: "removed" },
          );
        }),
      ),
  );

  it.live.each(["win32", "linux"] as const)(
    "matches a provider session at the worktree root with host casing rules (%s)",
    (platform) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture().pipe(
            Effect.provideService(HostProcess.Platform, platform),
          );
          fixture.setOpenSessionCwd(fixture.worktree.toUpperCase());
          const report = yield* fixture.service.runNow;
          expect(report.entries[0]).toMatchObject(
            platform === "win32"
              ? { outcome: "kept", reason: "Provider session is still open" }
              : { outcome: "removed" },
          );
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
  it.live.each(["same-device", "other-device", "no-manifest"] as const)(
    "counts the pnpm virtual store only when its store forces copies (%s)",
    (store) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const storeDir = yield* fs.makeTempDirectoryScoped({ prefix: "pnpm-store-" });
          const { service, worktree, setPolicy } = yield* cleanupFixture().pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              stat: (target) =>
                fs
                  .stat(target)
                  .pipe(
                    Effect.map((info) =>
                      store === "other-device" && target === storeDir
                        ? { ...info, dev: info.dev + 1n }
                        : info,
                    ),
                  ),
            }),
          );
          setPolicy("tracked-changes");
          const nodeModules = `${worktree}/node_modules`;
          yield* fs.makeDirectory(`${nodeModules}/.pnpm/pkg@1.0.0`, { recursive: true });
          yield* fs.makeDirectory(`${nodeModules}/.vite`);
          yield* fs.writeFileString(
            `${nodeModules}/.pnpm/pkg@1.0.0/index.js`,
            "clone ".repeat(10_000),
          );
          yield* fs.writeFileString(`${nodeModules}/.vite/deps.js`, "cache");
          if (store !== "no-manifest")
            yield* fs.writeFileString(
              `${nodeModules}/.modules.yaml`,
              JSON.stringify({ storeDir, virtualStoreDir: ".pnpm" }),
            );
          const counted = [
            ...(yield* fs.readDirectory(worktree)).flatMap((name) =>
              name === "node_modules" ? [] : [`${worktree}/${name}`],
            ),
            `${nodeModules}/.vite/deps.js`,
            ...(store === "no-manifest" ? [] : [`${nodeModules}/.modules.yaml`]),
            ...(store === "same-device" ? [] : [`${nodeModules}/.pnpm/pkg@1.0.0/index.js`]),
          ];
          const bytes = (yield* Effect.forEach(counted, (file) => allocatedBytes(fs, file))).reduce(
            (sum, size) => sum + size,
            0,
          );
          const report = yield* service.runNow;
          expect(report.entries[0]).toMatchObject({ outcome: "removed", bytes });
        }),
      ),
  );
  // An agent can write this manifest. Statting its store sent the Windows
  // user's NTLM credentials to attacker.test during a background sweep.
  it.live.each([
    { storeDir: "\\\\attacker.test\\s" },
    { storeDir: "/local/store", virtualStoreDir: "//attacker.test/s" },
  ])("never stats a network pnpm store %o", (manifest) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const statted: Array<string> = [];
        const { service, worktree, setPolicy } = yield* cleanupFixture().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            stat: (target) => {
              statted.push(target);
              return fs.stat(target);
            },
          }),
        );
        setPolicy("tracked-changes");
        yield* fs.makeDirectory(`${worktree}/node_modules`);
        yield* fs.writeFileString(
          `${worktree}/node_modules/.modules.yaml`,
          JSON.stringify(manifest),
        );
        expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "removed" });
        expect(statted.filter((target) => target.includes("attacker.test"))).toEqual([]);
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
        const { service, fs, repo, worktree, command, setThreads, fullStatusCalls } =
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
        expect(locked).toMatchObject({
          outcome: "failed",
          projectPath: repo,
          path: worktree,
          threadId: "thread-1",
          threadTitle: "Thread",
        });
        expect(locked?.reason).toContain("Git index is locked");
        expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe("original\n");
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
  it.live.each([
    { linked: "home", outcome: "removed", reason: "Removed 1 rotated logs" },
    { linked: "logs folder", outcome: "kept", reason: "No expired files" },
  ] as const)(
    "rotated logs behind a symlinked $linked are $outcome",
    ({ linked, outcome, reason }) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const config = yield* ServerConfig.ServerConfig;
          const disk = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
          yield* fs.makeDirectory(`${disk}/real/logs`, { recursive: true });
          if (linked === "home") {
            yield* fs.symlink(`${disk}/real`, `${disk}/home`);
          } else {
            yield* fs.makeDirectory(`${disk}/home`);
            yield* fs.symlink(`${disk}/real/logs`, `${disk}/home/logs`);
          }
          yield* fs.writeFileString(`${disk}/real/logs/server.log.1`, "log");
          yield* fs.utimes(`${disk}/real/logs/server.log.1`, 1, 1);
          const { service, enableFiles, disable } = yield* cleanupFixture().pipe(
            Effect.provideService(ServerConfig.ServerConfig, {
              ...config,
              logsDir: `${disk}/home/logs`,
            }),
          );
          disable();
          enableFiles();
          const report = yield* service.runNow;
          expect(report.entries.filter((entry) => entry.kind === "logs")).toMatchObject([
            { outcome, reason },
          ]);
          expect(yield* fs.exists(`${disk}/real/logs/server.log.1`)).toBe(outcome === "kept");
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

describe("settled worktree rechecks", () => {
  it.live.each(["autoResumeLimitedThreads", "snoozeLimitedThreads"] as const)(
    "keeps a usage-limited checkout when %s is enabled during measurement",
    (preference) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* pausedMeasurementFixture();
          fixture.setSettings({ autoResumeLimitedThreads: false, snoozeLimitedThreads: false });
          fixture.setThreads([
            shell({
              branch: "feature",
              worktreePath: fixture.worktree,
              status: "failed",
              latestRunId: RunId.make("limited-run"),
              lastErrorClass: "usage_limit",
              usageLimitResetAt: DateTime.formatIso(at(DAY_MS)),
            }),
          ]);
          const run = yield* fixture.service.runNow.pipe(Effect.forkChild);
          yield* Deferred.await(fixture.measuring);
          fixture.setSettings({ [preference]: true });
          yield* Deferred.succeed(fixture.resume, undefined);
          const report = yield* Fiber.join(run);
          expect(report.entries[0]?.outcome).toBe("kept");
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );
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
