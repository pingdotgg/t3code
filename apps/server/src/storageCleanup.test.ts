import { assert, describe, expect, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderSessionId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderSession,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import * as ServerActivation from "./serverActivation.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as DateTime from "effect/DateTime";
import { storageCleanupActivityAt, storageCleanupThreadIdle } from "./storageCleanup.ts";

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

describe("settled worktree retention", () => {
  it.effect.each([
    "immediate",
    "wait",
    "expired",
    "auto-recent",
    "legacy",
    "active",
    "pinned-active",
    "dirty",
    "session",
    "project-off",
    "project-custom",
    "archived",
    "woke",
    "updated",
    "shared",
    "shared-alias",
    "shared-alias-cycle",
    "archived-shared-alias-cycle",
    "shared-alias-late",
    "session-alias",
    "session-alias-descendant",
    "session-alias-cycle",
    "terminal-alias",
    "terminal-alias-descendant",
    "terminal-alias-cycle",
    "terminal-worktree-alias",
    "project-alias",
    "project-alias-descendant",
    "archived-alias",
    "deleted-alias",
    "deleted-shared-alias",
    "settled-event",
    "session-stop",
    "burst",
  ] as const)("preserves the original cleanup rules (%s)", (protection) => {
    const warnings: string[] = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(String(message));
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const worktreeDirectory = path.join(config.worktreesDir, "feature");
      yield* fs.makeDirectory(worktreeDirectory, { recursive: true });
      const worktreePath = yield* fs.realPath(worktreeDirectory);
      yield* fs.writeFileString(path.join(worktreePath, ".git"), "gitdir: /test/admin");
      const worktreeAlias = path.join(config.baseDir, "feature-alias");
      yield* fs.symlink(worktreePath, worktreeAlias);
      const activityAlias = protection.endsWith("-cycle")
        ? path.join(config.baseDir, "cycle")
        : worktreeAlias;
      if (protection.endsWith("-cycle")) yield* fs.symlink(activityAlias, activityAlias);
      let thread: OrchestrationV2AppThread = {
        ...shell(),
        lastVisitedAt: null,
        branch: "feature",
        worktreePath:
          protection === "archived-alias" || protection.startsWith("deleted-")
            ? worktreeAlias
            : worktreePath,
        deletedAt: protection.startsWith("deleted-") ? at(0) : null,
        settledOverride:
          protection === "legacy" ? null : protection === "pinned-active" ? "active" : "settled",
        settledAt:
          protection === "active" || protection === "settled-event"
            ? null
            : protection === "expired" || protection === "auto-recent"
              ? at(-20 * DAY_MS)
              : at(0),
        updatedAt: protection === "auto-recent" ? at(0) : at(-10 * DAY_MS),
        archivedAt: protection === "archived" || protection === "archived-alias" ? at(0) : null,
      };
      const event = (
        type: "thread.created" | "thread.settled" | "thread.unsettled" | "thread.metadata-updated",
      ) => ({
        id: EventId.make(`event:${type}`),
        type,
        threadId: thread.id,
        occurredAt: at(0),
        payload: thread,
      });
      yield* store.apply(event("thread.created"));
      if (protection.startsWith("deleted-")) {
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            scripts_json, created_at, updated_at, deleted_at
          ) VALUES (
            ${thread.projectId}, 'Project', ${config.baseDir}, NULL, '[]',
            ${DateTime.formatIso(at(0))}, ${DateTime.formatIso(at(0))}, NULL
          )
        `;
      }
      if (
        [
          "shared",
          "shared-alias",
          "shared-alias-cycle",
          "archived-shared-alias-cycle",
          "deleted-shared-alias",
        ].includes(protection)
      ) {
        yield* store.apply({
          ...event("thread.created"),
          id: EventId.make("shared"),
          threadId: ThreadId.make("shared"),
          payload: {
            ...thread,
            id: ThreadId.make("shared"),
            worktreePath: protection.endsWith("-cycle")
              ? activityAlias
              : protection === "shared-alias"
                ? worktreeAlias
                : worktreePath,
            deletedAt: null,
            archivedAt: protection === "shared-alias-cycle" ? null : at(0),
            settledOverride: "active",
          },
        });
      }
      const session: OrchestrationV2ProviderSession = {
        id: ProviderSessionId.make("session"),
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: thread.providerInstanceId,
        status: "ready",
        cwd: protection.startsWith("session-alias")
          ? protection === "session-alias-descendant"
            ? path.join(worktreeAlias, "missing-child")
            : activityAlias
          : worktreePath,
        model: null,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: at(0),
        updatedAt: at(0),
        lastError: null,
      };
      if (
        protection === "session" ||
        protection === "session-stop" ||
        protection.startsWith("session-alias")
      ) {
        yield* store.apply({
          id: EventId.make("session"),
          type: "provider-session.attached",
          threadId: thread.id,
          occurredAt: at(0),
          payload: session,
        });
      }
      const snapshots = yield* Queue.unbounded<void>();
      const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
      const subscription = yield* PubSub.subscribe(events);
      const activation = yield* Deferred.make<void>();
      const gitStarted = yield* Deferred.make<void>();
      const releaseGit = yield* Deferred.make<void>();
      const burstConsumed = yield* Deferred.make<void>();
      let eventCount = 0;
      let snapshotReads = 0;
      const settings = yield* ServerSettings.ServerSettingsService.pipe(
        Effect.provide(
          ServerSettings.layerTest({
            storageCleanup: {
              worktreeOnDelete: protection.startsWith("deleted-"),
              worktreeSettledAfterDays:
                protection === "project-custom"
                  ? null
                  : ["wait", "expired", "auto-recent"].includes(protection)
                    ? 8
                    : 0,
            },
            projectSettingsOverrides: {
              [thread.projectId]:
                protection === "project-off"
                  ? { worktreeCleanup: { mode: "off" } }
                  : protection === "project-custom"
                    ? {
                        worktreeCleanup: {
                          mode: "custom",
                          rules: {
                            worktreeAfterDays: null,
                            worktreeSettledAfterDays: 0,
                            worktreeOnDelete: false,
                            worktreeOnMerge: false,
                            worktreeUnchanged: false,
                          },
                        },
                      }
                    : {},
            },
          }),
        ),
      );
      let headReads = 0;
      let removals = 0;
      const cleanup = yield* StorageCleanup.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ServerSettings.ServerSettingsService, settings),
            Layer.succeed(SqlClient.SqlClient, sql),
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
            Layer.succeed(ProjectionStore.ProjectionStoreV2, {
              ...store,
              getShellSnapshot: (options) =>
                store.getShellSnapshot(options).pipe(
                  Effect.tap(() =>
                    options?.location === "archive"
                      ? Effect.sync(() => {
                          snapshotReads++;
                        }).pipe(Effect.andThen(Queue.offer(snapshots, undefined)))
                      : Effect.void,
                  ),
                ),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () =>
                Effect.succeed([
                  {
                    id: thread.projectId,
                    title: "Project",
                    workspaceRoot:
                      protection === "project-alias"
                        ? worktreeAlias
                        : protection === "project-alias-descendant"
                          ? path.join(worktreeAlias, "missing-child")
                          : config.baseDir,
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: DateTime.formatIso(at(0)),
                    updatedAt: DateTime.formatIso(at(0)),
                  },
                ]),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromSubscription(subscription).pipe(
                Stream.tap(() => {
                  eventCount++;
                  return eventCount === 100
                    ? Deferred.succeed(burstConsumed, undefined)
                    : Effect.void;
                }),
              ),
            }),
            Layer.mock(GitManager.GitManager)({ invalidateStatus: () => Effect.void }),
            Layer.mock(TerminalManager.TerminalManager)({
              subscribeMetadata: (listener) =>
                listener({
                  type: "snapshot",
                  terminals: protection.startsWith("terminal-")
                    ? [
                        {
                          threadId: thread.id,
                          terminalId: "term-1",
                          cwd:
                            protection === "terminal-worktree-alias"
                              ? config.baseDir
                              : protection === "terminal-alias-descendant"
                                ? path.join(worktreeAlias, "missing-child")
                                : activityAlias,
                          worktreePath:
                            protection === "terminal-worktree-alias" ? worktreeAlias : null,
                          status: "running",
                          pid: null,
                          exitCode: null,
                          exitSignal: null,
                          hasRunningSubprocess: false,
                          label: "Shell",
                          updatedAt: DateTime.formatIso(at(0)),
                        },
                      ]
                    : [],
                }).pipe(Effect.as(() => {})),
            }),
            Layer.mock(GitVcsDriver.GitVcsDriver)({
              statusDetailsLocal: () =>
                Effect.succeed({
                  isRepo: true,
                  hasOriginRemote: false,
                  isDefaultBranch: false,
                  branch: "feature",
                  upstreamRef: null,
                  hasWorkingTreeChanges: protection === "dirty",
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: false,
                  aheadCount: 0,
                  behindCount: 0,
                  aheadOfDefaultCount: 0,
                }),
              resolveCommit: () =>
                Effect.sync(() => {
                  headReads++;
                  return { commitSha: "a".repeat(40) };
                }),
              execute: () =>
                Effect.succeed({
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout: "",
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }).pipe(
                  Effect.tap(() => {
                    if (protection === "burst" && headReads === 1)
                      return Deferred.succeed(gitStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseGit)),
                      );
                    if (headReads === 1 && protection === "shared-alias-late")
                      return store
                        .apply({
                          ...event("thread.created"),
                          id: EventId.make("shared-late"),
                          threadId: ThreadId.make("shared"),
                          payload: {
                            ...thread,
                            id: ThreadId.make("shared"),
                            worktreePath: worktreeAlias,
                          },
                        })
                        .pipe(Effect.orDie);
                    if (headReads !== 1 || (protection !== "woke" && protection !== "updated"))
                      return Effect.void;
                    thread =
                      protection === "woke"
                        ? { ...thread, settledOverride: "active", settledAt: null }
                        : { ...thread, updatedAt: at(0) };
                    return store
                      .apply(
                        event(
                          protection === "woke" ? "thread.unsettled" : "thread.metadata-updated",
                        ),
                      )
                      .pipe(Effect.orDie);
                  }),
                ),
              removeWorktree: (input) => {
                assert.strictEqual(input.force, false);
                removals++;
                return fs.remove(input.path, { recursive: true }).pipe(Effect.orDie);
              },
            }),
          ),
        ),
      );
      yield* cleanup.start();
      yield* Deferred.succeed(activation, undefined);
      yield* Queue.take(snapshots);
      if (protection === "burst") {
        yield* Deferred.await(gitStarted);
        yield* PubSub.publishAll(
          events,
          Array.from({ length: 100 }, () => event("thread.settled")),
        );
        yield* Deferred.await(burstConsumed);
        yield* Deferred.succeed(releaseGit, undefined);
      }
      yield* cleanup.drain;
      if (protection === "burst") assert.strictEqual(snapshotReads, 3);
      if (protection === "settled-event" || protection === "session-stop") {
        assert.strictEqual(yield* fs.exists(worktreePath), true);
        yield* Queue.clear(snapshots);
        const nextEvent: OrchestrationV2DomainEvent =
          protection === "settled-event"
            ? {
                ...event("thread.settled"),
                payload: { ...thread, settledAt: at(0), updatedAt: at(0) },
              }
            : {
                id: EventId.make("stopped"),
                type: "provider-session.updated",
                threadId: thread.id,
                occurredAt: at(0),
                payload: { ...session, status: "stopped" },
              };
        yield* store.apply(nextEvent);
        yield* PubSub.publish(events, nextEvent);
        yield* Queue.take(snapshots);
        yield* cleanup.drain;
      }
      const removed = [
        "immediate",
        "expired",
        "legacy",
        "project-custom",
        "archived",
        "archived-alias",
        "deleted-alias",
        "settled-event",
        "session-stop",
        "burst",
      ].includes(protection);
      assert.strictEqual(yield* fs.exists(worktreePath), !removed);
      assert.strictEqual(removals, removed ? 1 : 0);
      if (protection === "session-alias-cycle")
        assert.isTrue(
          warnings.some((message) =>
            message.includes("storage cleanup could not resolve provider session workspace"),
          ),
        );
      if (
        ["terminal-alias-cycle", "shared-alias-cycle", "archived-shared-alias-cycle"].includes(
          protection,
        )
      )
        assert.isTrue(warnings.some((message) => message.includes("worktree cleanup failed")));
      if (["wait", "auto-recent", "active", "pinned-active"].includes(protection))
        assert.strictEqual(headReads, 0);
      assert.strictEqual(
        thread.worktreePath,
        protection === "archived-alias" || protection.startsWith("deleted-")
          ? worktreeAlias
          : worktreePath,
      );
      assert.strictEqual(thread.branch, "feature");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-settled-cleanup-" }),
          ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
          Logger.layer([logger], { mergeWithExisting: false }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.scoped,
    );
  });
});
