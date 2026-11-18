import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata commands"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "dispatch-mode-limit" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const supervised = { runtimeMode: "approval-required", interactionMode: "default" } as const;

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:dispatch-mode-limit"),
      title: "Before",
      modelSelection: { instanceId, model: "gpt-5" },
      ...supervised,
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

it.layer(layerTest)("DispatchModeLimit", (it) => {
  it.effect("refuses a limited command on a thread its user raised, and records nothing", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:limit-raised");
      yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("raise"),
        threadId,
        runtimeMode: "full-access",
      });
      const rename = {
        type: "thread.metadata.update",
        commandId: CommandId.make("rename"),
        threadId,
        title: "After",
      } as const;
      const refused = yield* orchestrator
        .dispatch(rename)
        .pipe(Effect.provideService(DispatchModeLimit, supervised), Effect.flip);
      assert.equal(refused._tag, "OrchestratorThreadAboveModeLimitError");
      assert.equal((yield* projections.getThreadShell(threadId))?.title, "Before");

      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("lower"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* orchestrator
        .dispatch(rename)
        .pipe(Effect.provideService(DispatchModeLimit, supervised));
      assert.equal((yield* projections.getThreadShell(threadId))?.title, "After");
    }),
  );

  it.effect("refuses to fork a source thread its user raised", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sourceThreadId = ThreadId.make("thread:limit-fork-source");
      const targetThreadId = ThreadId.make("thread:limit-fork-target");
      yield* createThread(sourceThreadId);
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("raise-source"),
        threadId: sourceThreadId,
        runtimeMode: "full-access",
      });
      const fork = {
        type: "thread.fork",
        commandId: CommandId.make("fork"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
        createdBy: "agent",
        creationSource: "mcp",
      } as const;
      const refused = yield* orchestrator
        .dispatch(fork)
        .pipe(Effect.provideService(DispatchModeLimit, supervised), Effect.flip);
      assert.ok(refused._tag === "OrchestratorThreadAboveModeLimitError");
      assert.equal(refused.threadId, sourceThreadId);
      assert.isNull(yield* projections.getThreadShell(targetThreadId));

      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("lower-source"),
        threadId: sourceThreadId,
        runtimeMode: "approval-required",
      });
      const retried = yield* orchestrator
        .dispatch(fork)
        .pipe(Effect.provideService(DispatchModeLimit, supervised), Effect.flip);
      assert.equal(retried._tag, "OrchestratorDispatchError");
    }),
  );
});

const layerPolicyDatabase = SqlitePersistence.layerMemory;
const layerWithCeiling = Layer.mergeAll(
  layerPolicyDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerPolicyDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "runtime-mode-ceiling" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    {
      databaseLayer: layerPolicyDatabase,
      runEffectWorker: false,
      managedPolicy: {
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { maxRuntimeMode: "auto-accept-edits", scheduledTasks: false },
      },
    },
  ),
);

const sendMessage = (threadId: ThreadId, id: string) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`send:${id}`),
  threadId,
  messageId: MessageId.make(`message:${id}`),
  text: id,
  attachments: [],
  dispatchMode: { type: "start_immediately" as const },
  createdBy: "user" as const,
  creationSource: "web" as const,
});

/** A thread that ran in full access before the policy arrived, as an import or an older build leaves it. */
const raiseBehindPolicy = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    yield* createThread(threadId);
    const { thread } = yield* orchestrator.getThreadRecords(threadId, []);
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:raise-behind-policy:${threadId}`),
          type: "thread.runtime-mode-updated",
          threadId,
          occurredAt: yield* DateTime.now,
          payload: { ...thread, runtimeMode: "full-access" },
        },
      ],
    });
  });

it.layer(layerWithCeiling)("runtime mode ceiling", (it) => {
  it.effect("refuses the user's own thread and mode changes above the ceiling", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:ceiling-user");
      const create = {
        type: "thread.create",
        commandId: CommandId.make("create:ceiling-user:full"),
        threadId,
        projectId: ProjectId.make("project:dispatch-mode-limit"),
        title: "Full",
        modelSelection: { instanceId, model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      } as const;
      const refusedCreate = yield* orchestrator.dispatch(create).pipe(Effect.flip);
      assert.ok(refusedCreate._tag === "OrchestratorRuntimeModeAboveCeilingError");
      assert.equal(refusedCreate.refused, "mode");
      assert.equal(refusedCreate.message, "Example Corp limits threads to Auto-accept edits.");
      assert.isNull(yield* projections.getThreadShell(threadId));

      yield* createThread(threadId);
      const raise = yield* orchestrator
        .dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("raise:ceiling-user"),
          threadId,
          runtimeMode: "auto",
        })
        .pipe(Effect.flip);
      assert.equal(raise._tag, "OrchestratorRuntimeModeAboveCeilingError");
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("raise-to-ceiling:ceiling-user"),
        threadId,
        runtimeMode: "auto-accept-edits",
      });
      assert.equal((yield* projections.getThreadShell(threadId))?.runtimeMode, "auto-accept-edits");
    }),
  );

  it.effect("narrows an MCP caller's limit to the ceiling inside the lock", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:ceiling-mcp");
      yield* createThread(threadId);
      const fullAccessCaller = { runtimeMode: "full-access", interactionMode: "default" } as const;
      const raise = yield* orchestrator
        .dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("raise:ceiling-mcp"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.provideService(DispatchModeLimit, fullAccessCaller), Effect.flip);
      assert.equal(raise._tag, "OrchestratorRuntimeModeAboveCeilingError");

      const raisedThreadId = ThreadId.make("thread:ceiling-mcp-raised");
      yield* raiseBehindPolicy(raisedThreadId);
      const rename = yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("rename:ceiling-mcp"),
          threadId: raisedThreadId,
          title: "After",
        })
        .pipe(Effect.provideService(DispatchModeLimit, fullAccessCaller), Effect.flip);
      assert.equal(rename._tag, "OrchestratorThreadAboveModeLimitError");
      assert.equal((yield* projections.getThreadShell(raisedThreadId))?.title, "Before");
    }),
  );

  it.effect("refuses turns on a thread above the ceiling until its mode is lowered", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:ceiling-raised");
      yield* raiseBehindPolicy(threadId);

      const refused = yield* orchestrator
        .dispatch(sendMessage(threadId, "first"))
        .pipe(Effect.flip);
      assert.ok(refused._tag === "OrchestratorRuntimeModeAboveCeilingError");
      assert.equal(refused.refused, "turn");
      assert.equal(
        refused.message,
        "Example Corp limits threads to Auto-accept edits. Switch this thread's mode to continue.",
      );
      assert.lengthOf((yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs, 0);

      // The user's own housekeeping and the way back down stay open.
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename:ceiling-raised"),
        threadId,
        title: "After",
      });
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("lower:ceiling-raised"),
        threadId,
        runtimeMode: "approval-required",
      });
      // Refusals record no receipt, so the same command goes through once the mode is lowered.
      yield* orchestrator.dispatch(sendMessage(threadId, "first"));
      assert.lengthOf((yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs, 1);
      assert.equal((yield* projections.getThreadShell(threadId))?.title, "After");
    }),
  );

  it.effect("starts a queue that waited above the ceiling once the mode is lowered", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:ceiling-queue");
      yield* createThread(threadId);
      yield* orchestrator.dispatch(sendMessage(threadId, "running"));
      yield* orchestrator.dispatch({
        ...sendMessage(threadId, "waiting"),
        dispatchMode: { type: "queue_after_active" },
      });
      // The policy arrives with the thread above it and its first run ending.
      const { thread, runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      const [running, waiting] = runs;
      const occurredAt = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:ceiling-queue:raise"),
            type: "thread.runtime-mode-updated",
            threadId,
            occurredAt,
            payload: { ...thread, runtimeMode: "full-access" },
          },
          {
            id: EventId.make("event:ceiling-queue:complete"),
            type: "run.updated",
            threadId,
            runId: running!.id,
            providerInstanceId: running!.providerInstanceId,
            occurredAt,
            payload: { ...running!, status: "completed" },
          },
        ],
      });

      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("lower:ceiling-queue"),
        threadId,
        runtimeMode: "approval-required",
      });
      const started = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
        (run) => run.id === waiting!.id,
      );
      assert.notEqual(started?.status, "queued");
    }),
  );

  it.effect("refuses a persisted scheduled run without blocking the next user message", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:scheduled-policy-queue");
      yield* createThread(threadId);
      yield* orchestrator.dispatch(sendMessage(threadId, "active"));
      yield* orchestrator.dispatch({
        ...sendMessage(threadId, "scheduled"),
        dispatchMode: { type: "queue_after_active" },
      });
      yield* orchestrator.dispatch({
        ...sendMessage(threadId, "ordinary"),
        dispatchMode: { type: "queue_after_active" },
      });
      const { runs, messages } = yield* orchestrator.getThreadRecords(threadId, [
        "runs",
        "messages",
      ]);
      const active = runs.find((run) => run.userMessageId === MessageId.make("message:active"))!;
      const scheduledRun = runs.find(
        (run) => run.userMessageId === MessageId.make("message:scheduled"),
      )!;
      const scheduled = messages.find(
        (message) => message.id === MessageId.make("message:scheduled"),
      )!;
      const occurredAt = yield* DateTime.now;
      // Persisted before the administrator disabled scheduled tasks.
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:scheduled-policy-queue:message"),
            type: "message.updated",
            threadId,
            occurredAt,
            payload: {
              ...scheduled,
              scheduledTaskId: ScheduledTaskId.make("scheduled-task:before-policy"),
            },
          },
        ],
      });
      const promoted = yield* orchestrator
        .dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote:scheduled-policy-queue"),
          threadId,
          queuedRunId: scheduledRun.id,
          targetRunId: active.id,
        })
        .pipe(Effect.flip);
      assert.equal(promoted._tag, "OrchestratorDispatchError");
      assert.equal(
        "cause" in promoted ? promoted.cause : undefined,
        "Example Corp's policy does not allow scheduled tasks.",
      );
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:scheduled-policy-queue:complete"),
            type: "run.updated",
            threadId,
            runId: active.id,
            providerInstanceId: active.providerInstanceId,
            occurredAt,
            payload: { ...active, status: "completed" },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume:scheduled-policy-queue"),
        threadId,
      });
      const refused = yield* orchestrator.getThreadRecords(threadId, ["runs", "turnItems"]);
      assert.equal(
        refused.runs.find((run) => run.userMessageId === scheduled.id)?.status,
        "failed",
      );
      assert.ok(
        refused.turnItems.some(
          (item) =>
            item.type === "error" &&
            item.failure.message === "Example Corp's policy does not allow scheduled tasks.",
        ),
      );
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume:ordinary-policy-queue"),
        threadId,
      });
      const ordinary = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
        (run) => run.userMessageId === MessageId.make("message:ordinary"),
      );
      assert.equal(ordinary?.status, "starting");
    }),
  );
  it.effect(
    "refuses restart continuations of scheduled origins while allowing ordinary restarts",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        for (const scheduled of [false, true]) {
          for (const chained of [false, true]) {
            const suffix = String(scheduled) + String(chained);
            const threadId = ThreadId.make("thread:restart-policy:" + suffix);
            yield* createThread(threadId);
            yield* orchestrator.dispatch(sendMessage(threadId, "origin:" + suffix));
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const original = projection.runs[0]!;
            const message = projection.messages.find((item) => item.id === original.userMessageId)!;
            const occurredAt = yield* DateTime.now;
            yield* sink.write({
              events: [
                {
                  id: EventId.make("cancel:" + suffix),
                  type: "run.updated",
                  threadId,
                  runId: original.id,
                  occurredAt,
                  payload: { ...original, status: "cancelled", completedAt: occurredAt },
                },
                {
                  id: EventId.make("origin:" + suffix),
                  type: "message.updated",
                  threadId,
                  occurredAt,
                  payload: {
                    ...message,
                    ...(scheduled
                      ? { scheduledTaskId: ScheduledTaskId.make("task:before-policy") }
                      : {}),
                  },
                },
              ],
            });
            let sourceId = original.id;
            if (chained) {
              yield* TestClock.adjust("1 second");
              yield* orchestrator.dispatch(sendMessage(threadId, "intermediate:" + suffix));
              const intermediate = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
              yield* sink.write({
                events: [
                  {
                    id: EventId.make("intermediate:" + suffix),
                    type: "run.updated",
                    threadId,
                    runId: intermediate.id,
                    occurredAt,
                    payload: {
                      ...intermediate,
                      status: "cancelled",
                      completedAt: occurredAt,
                      restartContinuationOfRunId: original.id,
                    },
                  },
                ],
              });
              yield* sink.write({
                events: [
                  {
                    id: EventId.make("compaction:" + suffix),
                    type: "turn-item.updated",
                    threadId,
                    occurredAt: yield* DateTime.now,
                    payload: {
                      id: TurnItemId.make("compaction:" + suffix),
                      type: "compaction",
                      driver: ProviderDriverKind.make("codex"),
                      threadId,
                      runId: intermediate.id,
                      nodeId: intermediate.rootNodeId,
                      providerThreadId: null,
                      providerTurnId: null,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: 10,
                      status: "completed",
                      title: null,
                      startedAt: intermediate.requestedAt,
                      completedAt: intermediate.requestedAt,
                      updatedAt: intermediate.requestedAt,
                    },
                  },
                ],
              });
              sourceId = intermediate.id;
            }
            const before = yield* orchestrator.getThreadProjection(threadId);
            yield* orchestrator.dispatch({
              ...sendMessage(threadId, "continuation:" + suffix),
              createdBy: "agent",
              creationSource: "server",
              restartContinuationOfRunId: sourceId,
            });
            const after = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(after.runs.length, before.runs.length + (scheduled ? 0 : 1));
            assert.equal(
              after.messages.some(
                (item) => item.id === MessageId.make("message:continuation:" + suffix),
              ),
              !scheduled,
            );
          }
        }
      }),
  );
  it.effect("refuses automatic usage-limit continuations of scheduled tasks", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      for (const scheduled of [false, true]) {
        const suffix = String(scheduled);
        const threadId = ThreadId.make("thread:usage-policy:" + suffix);
        yield* createThread(threadId);
        yield* orchestrator.dispatch(sendMessage(threadId, "limited:" + suffix));
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const run = projection.runs[0]!;
        const message = projection.messages.find((item) => item.id === run.userMessageId)!;
        const now = yield* DateTime.now;
        const resetAt = DateTime.formatIso(DateTime.add(now, { seconds: 1 }));
        yield* sink.write({
          events: [
            {
              id: EventId.make("limited-run:" + suffix),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...run, status: "failed", completedAt: now },
            },
            {
              id: EventId.make("limited-message:" + suffix),
              type: "message.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...message,
                ...(scheduled ? { scheduledTaskId: ScheduledTaskId.make("task:limited") } : {}),
              },
            },
            {
              id: EventId.make("limited-error:" + suffix),
              type: "turn-item.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make("limited-error:" + suffix),
                type: "error",
                threadId,
                runId: run.id,
                nodeId: run.rootNodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 2,
                status: "failed",
                title: "Usage limit reached",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                failure: {
                  class: "usage_limit",
                  message: "Plan limit reached.",
                  code: "usageLimitExceeded",
                  retryable: null,
                  resetAt,
                },
              },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("arm:" + suffix),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: true },
        });
        yield* TestClock.adjust("1 second");
        const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        const continuation = limitRecoveryCommand(
          shell,
          true,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
        assert.isNotNull(continuation);
        yield* orchestrator.dispatch(continuation!);
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).runs.length,
          scheduled ? 1 : 2,
        );
      }
    }),
  );
});
