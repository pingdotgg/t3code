import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  OrchestrationV2ProviderSessionJson,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ThreadShell,
  type ServerSettings,
  type StorageCleanupReport,
} from "@t3tools/contracts";
import type { DeepPartial } from "@t3tools/shared/Struct";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as Settings from "./serverSettings.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

const projectId = ProjectId.make("project-1");
const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const HEAD_SHA = "a".repeat(40);
const encodeSession = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2ProviderSessionJson));
// Far enough back that a 7-day inactivity rule applies.
const LONG_AGO = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

/** An idle thread with no activity since `LONG_AGO`. */
function shell(id: string, worktreePath: string): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make(id),
    projectId,
    title: id,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath,
    activeProviderThreadId: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
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
    branch: `branch-${id}`,
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
    createdAt: LONG_AGO,
    updatedAt: LONG_AGO,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
  };
}

function session(
  id: string,
  cwd: string,
  status: OrchestrationV2ProviderSession["status"],
): OrchestrationV2ProviderSession {
  return {
    id: ProviderSessionId.make(id),
    driver,
    providerInstanceId: instanceId,
    status,
    cwd,
    model: "gpt-5.4",
    capabilities: CodexProviderCapabilitiesV2,
    createdAt: LONG_AGO,
    updatedAt: LONG_AGO,
    lastError: null,
  };
}

function sessionEvent(
  index: number,
  status: OrchestrationV2ProviderSession["status"],
): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event-${index}`),
    type: "provider-session.updated",
    threadId: ThreadId.make("session-thread"),
    occurredAt: LONG_AGO,
    payload: session(`session-${index}`, "/elsewhere", status),
  };
}

/**
 * Runs the real cleanup service over fake Git, projections and events until
 * it drains. The first sweep signals `firstSweep.started` at its snapshot read
 * and waits there for `firstSweep.release`, so a test can land events while a
 * sweep is in flight.
 */
const runCleanup = (input: {
  readonly settings: DeepPartial<ServerSettings>;
  readonly workspaceRoot: string;
  readonly threads?: ReadonlyArray<OrchestrationV2ThreadShell>;
  /** The per-thread recheck's view; defaults to the snapshot's shell. */
  readonly latestShell?: (threadId: ThreadId) => OrchestrationV2ThreadShell | null;
  /** Threads that start using a worktree path after the snapshot. */
  readonly laterWorktreeUsers?: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly worktreePath: string;
  }>;
  readonly events?: Stream.Stream<OrchestrationV2DomainEvent>;
  readonly firstSweep: {
    readonly started: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
  readonly whileRunning?: Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const threads = input.threads ?? [];
    const counts = {
      snapshotReads: 0,
      threadShellReads: 0,
      removed: [] as Array<string>,
      report: null as StorageCleanupReport | null,
    };
    const layer = Layer.mergeAll(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getShellSnapshot: (options) =>
          Effect.gen(function* () {
            counts.snapshotReads++;
            if (options?.location !== "archive" && counts.snapshotReads === 1) {
              yield* Deferred.succeed(input.firstSweep.started, undefined);
              yield* Deferred.await(input.firstSweep.release);
            }
            return {
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: options?.location === "archive" ? [] : [...threads],
              archivedThreads: [],
            };
          }),
        getThreadWorktreePaths: () =>
          Effect.succeed([
            ...threads.flatMap((thread) =>
              thread.worktreePath === null
                ? []
                : [{ threadId: thread.id, worktreePath: thread.worktreePath }],
            ),
            ...(input.laterWorktreeUsers ?? []),
          ]),
        getThreadShell: (threadId) =>
          Effect.sync(() => {
            counts.threadShellReads++;
            return input.latestShell === undefined
              ? (threads.find((thread) => thread.id === threadId) ?? null)
              : input.latestShell(threadId);
          }),
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () =>
          Effect.succeed([
            {
              id: projectId,
              title: "Project",
              workspaceRoot: input.workspaceRoot,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            } satisfies OrchestrationProjectShell,
          ]),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: input.events ?? Stream.empty }),
      Layer.mock(TerminalManager.TerminalManager)({
        subscribeMetadata: () => Effect.succeed(() => {}),
      }),
      Layer.mock(GitManager.GitManager)({ invalidateStatus: () => Effect.void }),
      // Every worktree is clean, on its thread's branch, with no ignored files.
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        resolveCommit: () => Effect.succeed({ commitSha: HEAD_SHA }),
        execute: (command) =>
          Effect.sync(() => {
            if (command.args.includes("worktree") && command.args.includes("remove"))
              counts.removed.push(command.args.at(-1)!);
            const branch = threads.find((thread) => thread.worktreePath === command.cwd)?.branch;
            return {
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: command.args[0] === "symbolic-ref" ? `refs/heads/${branch}\n` : "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
      }),
      Settings.layerTest(input.settings),
    );
    yield* Effect.gen(function* () {
      const cleanup = yield* StorageCleanup.StorageCleanup;
      yield* Deferred.await(input.firstSweep.started);
      yield* input.whileRunning ?? Effect.void;
      yield* Deferred.succeed(input.firstSweep.release, undefined);
      yield* cleanup.drain;
      counts.report = yield* cleanup.latestReport;
    }).pipe(Effect.provide(StorageCleanup.layer.pipe(Layer.provide(layer))), Effect.scoped);
    return counts;
  });

const makeFirstSweep = Effect.all({
  started: Deferred.make<void>(),
  release: Deferred.make<void>(),
});

/** Session events emitted once the first sweep is in flight; `done` fires after the last one is handled. */
const burstDuringSweep = (
  started: Deferred.Deferred<void>,
  burst: ReadonlyArray<OrchestrationV2DomainEvent>,
  done: Deferred.Deferred<void>,
) =>
  Stream.fromEffect(Deferred.await(started)).pipe(
    Stream.flatMap(() => Stream.fromIterable(burst)),
    Stream.concat(Stream.fromEffect(Deferred.succeed(done, undefined)).pipe(Stream.drain)),
  );

/** Creates linked worktree directories and an idle thread for each. */
const makeWorktrees = (count: number) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(config.worktreesDir, { recursive: true });
    const worktreesDir = yield* fs.realPath(config.worktreesDir);
    const worktrees = Array.from({ length: count }, (_, i) => path.join(worktreesDir, `wt-${i}`));
    for (const worktree of worktrees) {
      yield* fs.makeDirectory(worktree);
      // A linked worktree has a .git file, not a directory.
      yield* fs.writeFileString(path.join(worktree, ".git"), "gitdir: /nowhere\n");
    }
    return worktrees.map((worktree, i) => shell(`thread-${i}`, worktree));
  });

const insertLiveSession = (id: string, threadId: string, cwd: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const live = session(id, cwd, "ready");
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_sessions (
        provider_session_id, thread_id, provider, driver, provider_instance_id,
        status, model, updated_at, payload_json
      ) VALUES (
        ${live.id}, ${threadId}, ${instanceId}, ${driver}, ${instanceId},
        ${live.status}, ${live.model}, ${DateTime.formatIso(live.updatedAt)}, ${encodeSession(live)}
      )
    `;
  });

const testLayer = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-storage-cleanup-sweeps-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const workspaceRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-storage-cleanup-project-" });
});

const makeWorktreesDir = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(config.worktreesDir, { recursive: true });
});

describe("storage cleanup sweep requests", () => {
  it.live("ignores session updates that cannot free a worktree", () =>
    Effect.gen(function* () {
      const firstSweep = yield* makeFirstSweep;
      const burstDone = yield* Deferred.make<void>();
      yield* makeWorktreesDir;
      const burst = Array.from({ length: 20 }, (_, i) =>
        sessionEvent(i, i % 2 === 0 ? "ready" : "running"),
      );
      const counts = yield* runCleanup({
        settings: { storageCleanup: { worktreeOnDelete: true } },
        workspaceRoot: yield* workspaceRoot,
        events: burstDuringSweep(firstSweep.started, burst, burstDone),
        firstSweep,
        whileRunning: Deferred.await(burstDone),
      });
      // One active and one archive read per sweep: only the scheduled sweep ran.
      assert.strictEqual(counts.snapshotReads, 2);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("merges requests made during a sweep into one more sweep", () =>
    Effect.gen(function* () {
      const firstSweep = yield* makeFirstSweep;
      const burstDone = yield* Deferred.make<void>();
      yield* makeWorktreesDir;
      const burst = Array.from({ length: 20 }, (_, i) =>
        sessionEvent(i, i % 2 === 0 ? "stopped" : "error"),
      );
      const counts = yield* runCleanup({
        settings: { storageCleanup: { worktreeOnDelete: true } },
        workspaceRoot: yield* workspaceRoot,
        events: burstDuringSweep(firstSweep.started, burst, burstDone),
        firstSweep,
        whileRunning: Deferred.await(burstDone),
      });
      assert.strictEqual(counts.snapshotReads, 2 * 2);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});

describe("storage cleanup rechecks", () => {
  const settings = { storageCleanup: { worktreeAfterDays: 7 } };

  it.live("reads the thread snapshot once per sweep however many worktrees qualify", () =>
    Effect.gen(function* () {
      const firstSweep = yield* makeFirstSweep;
      const threads = yield* makeWorktrees(4);
      // Live sessions keep the first two worktrees.
      for (const thread of threads.slice(0, 2)) {
        yield* insertLiveSession(`live-${thread.id}`, thread.id, thread.worktreePath!);
      }
      const counts = yield* runCleanup({
        settings,
        workspaceRoot: yield* workspaceRoot,
        threads,
        firstSweep,
      });
      assert.strictEqual(counts.snapshotReads, 2);
      // The recheck runs before and after measuring a worktree's size. A live
      // session stops the first two worktrees at their first recheck.
      assert.strictEqual(counts.threadShellReads, 2 + 2 * 2);
      assert.deepStrictEqual(
        counts.removed,
        threads.slice(2).map((thread) => thread.worktreePath),
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("keeps a worktree that another thread starts using after the snapshot", () =>
    Effect.gen(function* () {
      const firstSweep = yield* makeFirstSweep;
      const [thread] = yield* makeWorktrees(1);
      const counts = yield* runCleanup({
        settings,
        workspaceRoot: yield* workspaceRoot,
        threads: [thread!],
        laterWorktreeUsers: [
          { threadId: ThreadId.make("new-thread"), worktreePath: thread!.worktreePath! },
        ],
        firstSweep,
      });
      assert.deepStrictEqual(counts.removed, []);
      assert.strictEqual(
        counts.report?.entries[0]?.reason,
        "Thread activity or shared worktree changed since check",
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("keeps a worktree whose thread starts a turn after the snapshot", () =>
    Effect.gen(function* () {
      const firstSweep = yield* makeFirstSweep;
      const [thread] = yield* makeWorktrees(1);
      const counts = yield* runCleanup({
        settings,
        workspaceRoot: yield* workspaceRoot,
        threads: [thread!],
        latestShell: () => ({ ...thread!, status: "running", activeRunId: RunId.make("run-1") }),
        firstSweep,
      });
      assert.strictEqual(counts.threadShellReads, 1);
      assert.deepStrictEqual(counts.removed, []);
      assert.strictEqual(
        counts.report?.entries[0]?.reason,
        "Thread activity or shared worktree changed since check",
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
