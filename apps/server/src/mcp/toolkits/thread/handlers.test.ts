import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ScheduledTaskId,
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import {
  CheckpointRefUnavailableError,
  CheckpointTurnRangeUnavailableError,
} from "../../../checkpointing/Errors.ts";
import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ProviderReplayHarness from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ThreadHandlers from "./handlers.ts";
import { ThreadToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:mcp-thread-controls");
const instanceId = ProviderInstanceId.make("codex");
// The effect worker is off, so runs are recorded but no provider session opens.
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("No provider session in MCP thread control tests"),
};

const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
  { name: "mcp-thread-controls" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: layerDatabase, runEffectWorker: false },
);
const invocationScope = (access: "full-access" | "read-only") => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access },
  issuedAt: 0,
  capabilities: new Set(["orchestration" as const]),
});

const handlersOverDatabase = Layer.mergeAll(
  ThreadManagement.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
    Layer.provideMerge(layerOrchestrator),
  ),
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  NodeCrypto.layer,
  // Merged so the regression can seed runs the way completed runs persist.
  layerDatabase,
);
const layerHandlers = (access: "full-access" | "read-only") =>
  McpToolAccess.HandlersLayer.layer(ThreadHandlers.layer).pipe(
    Layer.provideMerge(handlersOverDatabase),
    Layer.provideMerge(
      Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScope(access)),
    ),
    Layer.provideMerge(layerDiffStub),
    // Only the cross-thread t3_thread_search path calls it; the threadId path never does.
    Layer.provideMerge(Layer.mock(ThreadSearch.ThreadSearch)({})),
  );
// Handlers other than t3_thread_diff never touch checkpoint diffs.
const layerDiffStub = Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({
  getThreadDiff: () => Effect.die("No CheckpointDiffQuery stub for this MCP thread control test"),
});
const layerTest = layerHandlers("full-access");
const layerReadOnly = layerHandlers("read-only");

/** A t3_thread_diff handler over a specific CheckpointDiffQuery, shadowing the stub. */
const diffOver = (
  getThreadDiff: CheckpointDiffQuery.CheckpointDiffQuery["Service"]["getThreadDiff"],
) => Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({ getThreadDiff });

const last = <A, E, R, E2, R2>(
  handled: Effect.Effect<Stream.Stream<{ readonly result: A }, E, R>, E2, R2>,
) =>
  handled.pipe(
    Stream.unwrap,
    Stream.runCollect,
    Effect.map((results) => results.at(-1)?.result),
  );

const createThreadOn = (id: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`mcp-thread-controls:create:${id}`),
      threadId: id,
      projectId: ProjectId.make("project:mcp-thread-controls"),
      title: "Thread controls",
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });
const createThread = createThreadOn(threadId);

// t3_thread_search resolves a thread's cwd through its project row, which the
// orchestrator's thread.create does not make.
const seedProject = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at
    ) VALUES (
      'project:mcp-thread-controls', 'Thread controls', '/tmp/mcp-thread-controls', '[]',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `;
});

const readThread = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return yield* projections.getThreadProjection(threadId);
});

// A worktree launch whose preparation failed persists the run and its error
// turn item; the queue stays held until a worktree exists.
const insertFailedPreparationRun = (ordinal: number, failedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runId = RunId.make(`run:api13-queue-prep-${ordinal}`);
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, provider_instance_id, provider_thread_id,
        status, requested_at, completed_at, payload_json
      )
      VALUES (
        ${runId}, ${threadId}, ${ordinal}, ${instanceId}, ${instanceId}, NULL,
        'failed', ${failedAt}, ${failedAt}, ${JSON.stringify({
          id: runId,
          threadId,
          ordinal,
          providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "gpt-5" },
          providerThreadId: null,
          userMessageId: MessageId.make(`message:api13-queue-prep-${ordinal}`),
          rootNodeId: null,
          activeAttemptId: null,
          status: "failed",
          requestedAt: failedAt,
          startedAt: failedAt,
          completedAt: failedAt,
          checkpointId: null,
          contextHandoffId: null,
          workspacePreparation: { type: "worktree", baseRef: "main" },
        })}
      )
    `;
    const itemId = `turn-item:api13-queue-prep-${ordinal}`;
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
        parent_item_id, ordinal, type, status, updated_at, payload_json
      )
      VALUES (
        ${itemId}, ${threadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
        'error', 'failed', ${failedAt}, ${JSON.stringify({
          id: itemId,
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "failed",
          title: "Workspace preparation failed",
          startedAt: failedAt,
          completedAt: failedAt,
          updatedAt: failedAt,
          type: "error",
          failure: {
            class: "unknown",
            message: `Worktree setup failed: setup script exited 1. ${"x".repeat(600)}`,
            code: ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
            retryable: true,
          },
        })}
      )
    `;
  });

// Mark-unread rewinds to a completed run, so the regression seeds one straight
// into the projection store the way a finished provider run would leave it.
const insertCompletedRun = (ordinal: number, completedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runId = `run:api13-read-receipts-${ordinal}`;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, provider_instance_id, provider_thread_id,
        status, requested_at, completed_at, payload_json
      )
      VALUES (
        ${runId}, ${threadId}, ${ordinal}, ${instanceId}, ${instanceId}, NULL,
        'completed', ${completedAt}, ${completedAt}, ${JSON.stringify({
          id: runId,
          threadId,
          ordinal,
          providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "gpt-5" },
          providerThreadId: null,
          userMessageId: `message:api13-read-receipts-${ordinal}`,
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: completedAt,
          startedAt: null,
          completedAt,
          checkpointId: null,
          contextHandoffId: null,
        })}
      )
    `;
  });

const readState = Effect.gen(function* () {
  const { thread, runs } = yield* readThread;
  const latestRunCompletedAt = runs.at(-1)?.completedAt ?? null;
  return {
    lastVisitedAt: thread.lastVisitedAt === null ? null : DateTime.formatIso(thread.lastVisitedAt),
    updatedAt: DateTime.formatIso(thread.updatedAt),
    latestRunCompletedAt:
      latestRunCompletedAt === null ? null : DateTime.formatIso(latestRunCompletedAt),
  };
});

it.effect("turns auto-settle off and on and reads it back", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* createThread;
    for (const [action, autoSettle] of [
      ["disable_auto_settle", false],
      ["enable_auto_settle", true],
    ] as const) {
      expect(
        yield* last(toolkit.handle("t3_thread_organize", { threadId, action })),
      ).toHaveProperty("sequence");
      expect(yield* last(toolkit.handle("t3_thread_configuration", { threadId }))).toMatchObject({
        autoSettle,
      });
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("sets and clears a goal with its loop paused, starting no work", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* createThread;
    expect(
      yield* last(toolkit.handle("t3_thread_goal", { threadId, goal: "First goal" })),
    ).toHaveProperty("sequence");
    expect(yield* last(toolkit.handle("t3_thread_configuration", { threadId }))).toMatchObject({
      goal: "First goal",
      goalLoop: { state: "paused", iterations: 0 },
    });

    expect(
      yield* last(
        toolkit.handle("t3_thread_goal_loop", {
          threadId,
          action: "resume",
          expectedState: "running",
        }),
      ),
    ).toMatchObject({ code: "invalid_request", message: "The goal loop is paused, not running." });
    expect((yield* readThread).thread.goalLoop?.state).toBe("paused");

    yield* last(
      toolkit.handle("t3_thread_goal_loop", {
        threadId,
        action: "resume",
        expectedState: "paused",
      }),
    );
    expect((yield* readThread).thread.goalLoop?.state).toBe("idle");
    // Changing the goal of a loop that is due to run pauses it again.
    expect(
      yield* last(toolkit.handle("t3_thread_goal", { threadId, goal: "Second goal" })),
    ).toHaveProperty("sequence");
    expect(yield* last(toolkit.handle("t3_thread_configuration", { threadId }))).toMatchObject({
      goal: "Second goal",
      goalLoop: { state: "paused" },
    });

    expect(yield* last(toolkit.handle("t3_thread_goal", { threadId, goal: null }))).toHaveProperty(
      "sequence",
    );
    const cleared = yield* readThread;
    expect(cleared.thread.goal).toBeNull();
    expect(cleared.thread.goalLoop).toBeNull();
    expect(cleared.runs).toHaveLength(0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "refuses text an unrelated thread puts into another thread when the owner blocks it",
  () => {
    const callerId = ThreadId.make("thread:mcp-thread-controls-outsider");
    let scheduledRuns = 0;
    const blocked = {
      code: "thread_not_sendable",
      message: "The owner has blocked messages from other threads",
    };
    return Effect.gen(function* () {
      const toolkit = yield* ThreadToolkit;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createThread;
      yield* createThreadOn(callerId);
      // Tools that write to another thread need a caller with a live run.
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("mcp-thread-controls:outsider:start"),
        threadId: callerId,
        messageId: MessageId.make("message:mcp-thread-controls-outsider"),
        text: "Work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("mcp-thread-controls:outsider:goal"),
        threadId,
        goal: "The owner's goal",
        goalLoopState: "paused",
      });

      expect(
        yield* last(toolkit.handle("t3_thread_goal", { threadId, goal: "An outsider's goal" })),
      ).toMatchObject(blocked);
      expect(
        yield* last(
          toolkit.handle("t3_thread_goal_loop", {
            threadId,
            action: "resume",
            expectedState: "paused",
          }),
        ),
      ).toMatchObject(blocked);
      expect(
        yield* last(
          toolkit.handle("t3_queue", {
            threadId,
            action: "edit",
            queuedRunId: RunId.make("run:any-queued"),
            text: "Do something else",
          }),
        ),
      ).toMatchObject(blocked);

      const target = yield* readThread;
      expect(target.thread.goal).toBe("The owner's goal");
      expect(target.thread.goalLoop?.state).toBe("paused");
      expect(target.runs).toHaveLength(0);
      expect(
        target.turnItems.flatMap((item) =>
          item.type === "notification" ? [[item.summary, item.detail]] : [],
        ),
      ).toEqual([
        [
          "T3 Code blocked a goal from Thread controls (other threads are blocked in Settings)",
          "An outsider's goal",
        ],
        [
          "T3 Code blocked a goal loop change (resume) from Thread controls (other threads are blocked in Settings)",
          undefined,
        ],
        [
          "T3 Code blocked an edit to a queued message from Thread controls (other threads are blocked in Settings)",
          "Do something else",
        ],
      ]);
      expect(
        yield* last(
          toolkit.handle("run_scheduled_task_now", {
            taskId: ScheduledTaskId.make("scheduled-task:bound"),
          }),
        ),
      ).toMatchObject(blocked);
      expect(scheduledRuns).toBe(0);
      // Its own thread is never an outsider.
      expect(
        yield* last(toolkit.handle("t3_thread_goal", { threadId: callerId, goal: "My own goal" })),
      ).toHaveProperty("sequence");
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ThreadHandlers.layer).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              ThreadManagement.layer.pipe(
                Layer.provide(ServerSettings.layerTest({ agentMessagePolicy: "block" })),
                Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
                Layer.provideMerge(layerOrchestrator),
              ),
              ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
              NodeCrypto.layer,
              layerDatabase,
            ),
          ),
          Layer.provideMerge(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("environment"),
              requestNamespace: `provider-session:${callerId}`,
              thread: {
                threadId: callerId,
                providerSessionId: `provider-session:${callerId}`,
                providerInstanceId: instanceId,
              },
              client: undefined,
              issuedAt: 0,
              capabilities: new Set(["orchestration" as const]),
            }),
          ),
          Layer.provideMerge(layerDiffStub),
          Layer.provideMerge(Layer.mock(ThreadSearch.ThreadSearch)({})),
          Layer.provideMerge(
            Layer.mock(ScheduledTasks.ScheduledTaskService)({
              list: () =>
                Effect.succeed({
                  tasks: [
                    {
                      id: ScheduledTaskId.make("scheduled-task:bound"),
                      threadId,
                      prompt: "The owner's scheduled prompt",
                    } as never,
                  ],
                }),
              runNow: () =>
                Effect.sync(() => {
                  scheduledRuns += 1;
                  return {} as never;
                }),
            }),
          ),
        ),
      ),
    );
  },
);

it.effect("refuses to start work that does not match the expected run", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* createThread;
    const runId = RunId.make("run:not-there");
    for (const action of ["retry_preparation", "start_queued", "resume_queue"] as const) {
      expect(
        yield* last(toolkit.handle("t3_run_start", { threadId, action, runId })),
      ).toMatchObject({
        code: expect.stringMatching(/^(invalid_request|orchestration_error)$/),
      });
    }
    expect((yield* readThread).runs).toHaveLength(0);
  }).pipe(Effect.provide(layerTest)),
);

const sendMessage = (
  id: string,
  dispatchMode: { readonly type: "start_immediately" | "queue_after_active" },
  target: ThreadId = threadId,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`mcp-thread-controls:${id}`),
      threadId: target,
      messageId: MessageId.make(`message:${id}`),
      text: id,
      attachments: [],
      dispatchMode,
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect("mark_read records a read receipt at the observed version", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* TestClock.adjust("2 hours");
    yield* createThread;
    yield* insertCompletedRun(1, "1970-01-01T01:00:00.000Z");
    expect(yield* readState).toEqual({
      lastVisitedAt: null,
      updatedAt: "1970-01-01T02:00:00.000Z",
      latestRunCompletedAt: "1970-01-01T01:00:00.000Z",
    });
    // The test clock moves an hour past the thread's last edit: a receipt
    // stamped from the handler's own clock would land at 03:00, not 02:00.
    yield* TestClock.adjust("1 hour");

    expect(
      yield* last(toolkit.handle("t3_thread_organize", { threadId, action: "mark_unread" })),
    ).toHaveProperty("sequence");
    expect(yield* readState).toMatchObject({ lastVisitedAt: "1970-01-01T00:59:59.999Z" });

    const beforeReceipt = (yield* readThread).thread;
    expect(
      yield* last(toolkit.handle("t3_thread_organize", { threadId, action: "mark_read" })),
    ).toHaveProperty("sequence");
    expect(yield* readState).toEqual({
      lastVisitedAt: "1970-01-01T02:00:00.000Z",
      updatedAt: "1970-01-01T02:00:00.000Z",
      latestRunCompletedAt: "1970-01-01T01:00:00.000Z",
    });
    // The receipt leaves the thread record byte-identical apart from the
    // watermark: no open or search stats, no settlement, pin, goal or edits.
    const afterReceipt = (yield* readThread).thread;
    expect({ ...afterReceipt, lastVisitedAt: null }).toEqual({
      ...beforeReceipt,
      lastVisitedAt: null,
    });

    // A repeat mark_read changes nothing.
    const settled = yield* readThread;
    yield* last(toolkit.handle("t3_thread_organize", { threadId, action: "mark_read" }));
    expect(yield* readThread).toEqual(settled);

    // A completion newer than the captured version stays unread, and the next
    // mark_unread rewinds to it instead of the stale receipt.
    yield* insertCompletedRun(2, "1970-01-01T04:00:00.000Z");
    expect(yield* readState).toEqual({
      lastVisitedAt: "1970-01-01T02:00:00.000Z",
      updatedAt: "1970-01-01T02:00:00.000Z",
      latestRunCompletedAt: "1970-01-01T04:00:00.000Z",
    });
    // Synthetic: this completion does not bump updatedAt, so the receipt
    // stamps 02:00 onto an identical 02:00 watermark — proof of equality,
    // not of backwards protection. A real newer completion would bump
    // updatedAt, and the next mark_read would stamp it, clearing the badge.
    yield* last(toolkit.handle("t3_thread_organize", { threadId, action: "mark_read" }));
    expect(yield* readState).toMatchObject({ lastVisitedAt: "1970-01-01T02:00:00.000Z" });
    yield* last(toolkit.handle("t3_thread_organize", { threadId, action: "mark_unread" }));
    expect(yield* readState).toMatchObject({ lastVisitedAt: "1970-01-01T03:59:59.999Z" });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("mark_read clears a passed snooze wake by stamping it instead of the older version", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* TestClock.adjust("2 hours");
    yield* createThread;
    expect(
      yield* last(
        toolkit.handle("t3_thread_organize", {
          threadId,
          action: "snooze",
          snoozedUntil: "1970-01-01T03:00:00.000Z",
        }),
      ),
    ).toHaveProperty("sequence");
    // The wake passes: the badge the clients show is snoozedUntil, so the
    // receipt must stamp it rather than the older updatedAt. The clock is
    // only consulted for this passed-wake comparison, never as the stamp.
    yield* TestClock.adjust("1 hour");
    expect(
      yield* last(toolkit.handle("t3_thread_organize", { threadId, action: "mark_read" })),
    ).toHaveProperty("sequence");
    expect(yield* readState).toEqual({
      lastVisitedAt: "1970-01-01T03:00:00.000Z",
      updatedAt: "1970-01-01T02:00:00.000Z",
      latestRunCompletedAt: null,
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("mark_read keeps a future snooze out of the receipt stamp", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* TestClock.adjust("2 hours");
    yield* createThread;
    expect(
      yield* last(
        toolkit.handle("t3_thread_organize", {
          threadId,
          action: "snooze",
          snoozedUntil: "1970-01-01T05:00:00.000Z",
        }),
      ),
    ).toHaveProperty("sequence");
    expect(
      yield* last(toolkit.handle("t3_thread_organize", { threadId, action: "mark_read" })),
    ).toHaveProperty("sequence");
    // The snooze is still ahead of the clock, so the stamp stays at the
    // observed version instead of jumping to the not-yet-reached wake.
    expect(yield* readState).toEqual({
      lastVisitedAt: "1970-01-01T02:00:00.000Z",
      updatedAt: "1970-01-01T02:00:00.000Z",
      latestRunCompletedAt: null,
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("denies a read-only client's mark_read and records nothing", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* createThread;
    const before = yield* readThread;
    expect(
      yield* last(toolkit.handle("t3_thread_organize", { threadId, action: "mark_read" })),
    ).toMatchObject({ code: "capability_denied" });
    expect(yield* readThread).toEqual(before);
  }).pipe(Effect.provide(layerReadOnly)),
);

it.effect.each(["resume_queue", "start_queued"] as const)(
  "%s starts held work only for the expected queued run",
  (action) =>
    Effect.gen(function* () {
      const toolkit = yield* ThreadToolkit;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createThread;
      yield* sendMessage("first", { type: "start_immediately" });
      yield* sendMessage("second", { type: "queue_after_active" });
      const [active, queued] = (yield* readThread).runs.toSorted((a, b) => a.ordinal - b.ordinal);
      if (active === undefined || queued === undefined) return yield* Effect.die("runs missing");
      expect(queued.status).toBe("queued");
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("mcp-thread-controls:stop"),
        threadId,
        runId: active.id,
        holdQueue: true,
      });
      expect((yield* readThread).runs.find((run) => run.id === queued.id)?.queueHeld).toBe(true);

      expect(
        yield* last(toolkit.handle("t3_run_start", { threadId, action, runId: active.id })),
      ).toMatchObject({
        code: action === "resume_queue" ? "invalid_request" : "orchestration_error",
      });
      expect((yield* readThread).runs.find((run) => run.id === queued.id)?.queueHeld).toBe(true);
      expect(
        yield* last(toolkit.handle("t3_run_start", { threadId, action, runId: queued.id })),
      ).toHaveProperty("sequence");
      expect((yield* readThread).runs.find((run) => run.id === queued.id)?.queueHeld).toBe(false);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("reads a held queue with each run's held flag", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* createThread;
    yield* sendMessage("first", { type: "start_immediately" });
    yield* sendMessage("second", { type: "queue_after_active" });
    const runs = (yield* readThread).runs;
    const active = runs.find((run) => run.status !== "queued");
    const queued = runs.find((run) => run.status === "queued");
    if (active === undefined || queued === undefined) return yield* Effect.die("runs missing");
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("mcp-thread-controls:hold"),
      threadId,
      runId: active.id,
      holdQueue: true,
    });

    expect(yield* last(toolkit.handle("t3_queue", { threadId, action: "list" }))).toMatchObject({
      queueHeld: true,
      holdReason: null,
      nextCursor: null,
      items: [
        {
          queuedRunId: queued.id,
          text: "second",
          truncated: false,
          queueHeld: true,
          attachmentCount: 0,
          attachments: [],
        },
      ],
    });
    expect(
      yield* last(toolkit.handle("t3_queue", { threadId, action: "read", queuedRunId: queued.id })),
    ).toMatchObject({ queuedRunId: queued.id, queueHeld: true, holdReason: null });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reads the workspace-preparation reason behind a held queue, bounded", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* createThread;
    yield* sendMessage("first", { type: "start_immediately" });
    yield* sendMessage("second", { type: "queue_after_active" });
    const [active, queued] = (yield* readThread).runs.toSorted((a, b) => a.ordinal - b.ordinal);
    if (active === undefined || queued === undefined) return yield* Effect.die("runs missing");
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("mcp-thread-controls:hold"),
      threadId,
      runId: active.id,
      holdQueue: true,
    });
    yield* insertFailedPreparationRun(3, "1970-01-01T03:00:00.000Z");

    const listed = yield* last(toolkit.handle("t3_queue", { threadId, action: "list" }));
    if (listed === undefined || !("holdReason" in listed)) {
      return yield* Effect.die("list result missing");
    }
    expect(listed).toMatchObject({ queueHeld: true });
    // The error message is bounded instead of handed over whole.
    expect(listed.holdReason?.startsWith("Worktree setup failed: setup script exited 1.")).toBe(
      true,
    );
    expect(listed.holdReason).toHaveLength(500);
    expect(
      yield* last(toolkit.handle("t3_queue", { threadId, action: "read", queuedRunId: queued.id })),
    ).toMatchObject({
      queuedRunId: queued.id,
      queueHeld: true,
      holdReason: listed.holdReason,
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reads queued attachment metadata without attachment content", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* createThread;
    yield* sendMessage("first", { type: "start_immediately" });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("mcp-thread-controls:attach"),
      threadId,
      messageId: MessageId.make("message:attached"),
      text: "with attachment",
      attachments: [
        {
          type: "file",
          id: "attachment-notes",
          name: "notes.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1234,
        },
      ],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });

    const listed = yield* last(toolkit.handle("t3_queue", { threadId, action: "list" }));
    if (listed === undefined || !("items" in listed)) return yield* Effect.die("list missing");
    expect(listed.items[0]).toMatchObject({
      text: "with attachment",
      attachmentCount: 1,
      attachments: [
        { name: "notes.pdf", type: "file", mimeType: "application/pdf", sizeBytes: 1234 },
      ],
    });
    // Metadata only: exactly the four safe fields, no content bytes or URLs.
    expect(Object.keys(listed.items[0]?.attachments[0] ?? {})).toEqual([
      "name",
      "type",
      "mimeType",
      "sizeBytes",
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("t3_thread_search with threadId finds matches in that transcript only", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* seedProject;
    yield* createThreadOn(threadId);
    const other = ThreadId.make("thread:mcp-thread-controls-other");
    yield* createThreadOn(other);
    yield* sendMessage("needle-in-target", { type: "start_immediately" });
    yield* sendMessage("needle-in-other", { type: "start_immediately" }, other);

    const found = yield* last(
      toolkit.handle("t3_thread_search", { threadId, query: "needle-in-target" }),
    );
    expect(found).toMatchObject({
      threadId,
      totalMatches: 1,
      matches: [{ entryId: expect.any(String), count: 1 }],
    });

    // The other thread holds this match; searching here must not return it.
    // Checked encoded: an empty result once lost threadId and totalMatches on the wire.
    const empty = yield* toolkit
      .handle("t3_thread_search", { threadId, query: "needle-in-other" })
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((results) => results.at(-1)?.encodedResult),
      );
    expect(empty).toEqual({ threadId, totalMatches: 0, matches: [] });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses to search a deleted thread", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    const gone = ThreadId.make("thread:mcp-thread-controls-deleted");
    yield* createThreadOn(gone);
    yield* sendMessage("needle-in-gone", { type: "start_immediately" }, gone);
    yield* (yield* Orchestrator.OrchestratorV2).dispatch({
      type: "thread.delete",
      commandId: CommandId.make("mcp-thread-controls:delete"),
      threadId: gone,
    });
    expect(
      yield* last(toolkit.handle("t3_thread_search", { threadId: gone, query: "needle-in-gone" })),
    ).toMatchObject({ code: "thread_not_found" });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("lowers a thread's modes and refuses to raise them, recording nothing", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* createThread;
    expect(
      yield* last(toolkit.handle("t3_thread_lower_modes", { threadId, runtimeMode: "auto" })),
    ).toHaveProperty("sequence");
    expect(
      yield* last(toolkit.handle("t3_thread_lower_modes", { threadId, interactionMode: "plan" })),
    ).toHaveProperty("sequence");
    const lowered = (yield* readThread).thread;
    expect(lowered).toMatchObject({ runtimeMode: "auto", interactionMode: "plan" });

    const message = "Agents can only lower a thread's modes; raise them in the app.";
    expect(
      yield* last(
        toolkit.handle("t3_thread_lower_modes", { threadId, runtimeMode: "full-access" }),
      ),
    ).toMatchObject({ code: "runtime_mode_escalation_denied", message });
    expect(
      yield* last(
        toolkit.handle("t3_thread_lower_modes", { threadId, interactionMode: "default" }),
      ),
    ).toMatchObject({ code: "interaction_mode_escalation_denied", message });
    expect((yield* readThread).thread).toEqual(lowered);
  }).pipe(Effect.provide(layerTest)),
);

const queriedDiff = {
  fromTurnCount: 1,
  toTurnCount: 2,
  latestTurnCount: 3,
  diff: "diff --git a/file.ts b/file.ts",
};

it.effect("reads one turn's checkpoint diff", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* createThread;
    const calls: Array<CheckpointDiffQuery.ThreadDiffInput> = [];
    expect(
      yield* last(
        toolkit.handle("t3_thread_diff", { threadId, turn: 2 }).pipe(
          Effect.provide(
            diffOver((input) =>
              Effect.sync(() => {
                calls.push(input);
                return queriedDiff;
              }),
            ),
          ),
        ),
      ),
    ).toEqual({ threadId, ...queriedDiff, truncated: false, totalChars: queriedDiff.diff.length });
    expect(calls).toEqual([{ threadId, turn: 2, ignoreWhitespace: undefined }]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reads the whole thread up to the latest ready turn without a turn", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* createThread;
    const calls: Array<CheckpointDiffQuery.ThreadDiffInput> = [];
    expect(
      yield* last(
        toolkit.handle("t3_thread_diff", { threadId }).pipe(
          Effect.provide(
            diffOver((input) =>
              Effect.sync(() => {
                calls.push(input);
                return queriedDiff;
              }),
            ),
          ),
        ),
      ),
    ).toEqual({ threadId, ...queriedDiff, truncated: false, totalChars: queriedDiff.diff.length });
    expect(calls).toEqual([{ threadId, turn: undefined, ignoreWhitespace: undefined }]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("truncates the diff to maxChars and flags it", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* createThread;
    const long = { ...queriedDiff, diff: "x".repeat(30) };
    expect(
      yield* last(
        toolkit
          .handle("t3_thread_diff", { threadId, maxChars: 10 })
          .pipe(Effect.provide(diffOver(() => Effect.succeed(long)))),
      ),
    ).toEqual({
      threadId,
      fromTurnCount: long.fromTurnCount,
      toTurnCount: long.toTurnCount,
      latestTurnCount: long.latestTurnCount,
      diff: "x".repeat(10),
      truncated: true,
      totalChars: 30,
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a turn above the thread's ready turns", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* createThread;
    expect(
      yield* last(
        toolkit.handle("t3_thread_diff", { threadId, turn: 5 }).pipe(
          Effect.provide(
            diffOver(() =>
              Effect.fail(
                new CheckpointTurnRangeUnavailableError({
                  operation: "CheckpointDiffQuery.getTurnDiff",
                  threadId,
                  requestedTurnCount: 5,
                  availableTurnCount: 3,
                }),
              ),
            ),
          ),
        ),
      ),
    ).toMatchObject({
      code: "invalid_request",
      message: "Turn 5 is not available: the thread has 3 ready turns.",
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a turn with no ready checkpoint", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* createThread;
    expect(
      yield* last(
        toolkit.handle("t3_thread_diff", { threadId, turn: 2 }).pipe(
          Effect.provide(
            diffOver(() =>
              Effect.fail(
                new CheckpointRefUnavailableError({
                  operation: "CheckpointDiffQuery.getTurnDiff",
                  threadId,
                  turnCount: 2,
                  checkpoint: "to",
                }),
              ),
            ),
          ),
        ),
      ),
    ).toMatchObject({
      code: "invalid_request",
      message: "Turn 2 has no ready checkpoint; try another turn.",
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a thread this client cannot read", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    expect(
      yield* last(toolkit.handle("t3_thread_diff", { threadId: ThreadId.make("thread:gone") })),
    ).toMatchObject({ code: "thread_not_found" });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("returns an empty diff for a thread with no ready turns", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* createThread;
    expect(
      yield* last(
        toolkit
          .handle("t3_thread_diff", { threadId })
          .pipe(
            Effect.provide(
              diffOver(() =>
                Effect.succeed({ fromTurnCount: 0, toTurnCount: 0, latestTurnCount: 0, diff: "" }),
              ),
            ),
          ),
      ),
    ).toEqual({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 0,
      latestTurnCount: 0,
      diff: "",
      truncated: false,
      totalChars: 0,
    });
  }).pipe(Effect.provide(layerTest)),
);
