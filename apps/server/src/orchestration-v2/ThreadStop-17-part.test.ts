import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as EventStore from "./EventStore.ts";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CLAUDE_PROVIDER } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { OrchestrationEffectRequestV2 } from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-stop" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const encodeEffectRequest = Schema.encodeSync(Schema.fromJsonString(OrchestrationEffectRequestV2));

const pullRequest = (number: number) => ({
  host: "github.com",
  repository: "pingdotgg/t3code",
  number,
});

const createWatchingThread = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-stop"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* watch(threadId, number);
  });

const watch = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make(`watch:${threadId}:${number}`),
      threadId,
      ...pullRequest(number),
      watching: true,
      link: { url: `https://github.com/pingdotgg/t3code/pull/${number}`, source: "agent" },
    });
  });

const send = (threadId: ThreadId, text: string, type: "start_immediately" | "queue_after_active") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

const delegate = (parentThreadId: ThreadId, task: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${task}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const projection = yield* orchestrator.getThreadProjection(parentThreadId);
    return projection.subagents.find((candidate) => candidate.prompt === task)!.childThreadId!;
  });

const threadState = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return {
      runs: projection.runs.map((run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`),
      watched: (projection.thread.pullRequests ?? [])
        .filter((link) => link.watch !== undefined)
        .map((link) => link.number),
    };
  });



















it.effect.each(["Stop", "Force stop"] as const)(
  "%s ends a running run whose provider turn already completed",
  (action) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:stop-completed-turn");
      yield* createWatchingThread(threadId, 7);
      yield* send(threadId, "go", "start_immediately");
      const now = yield* DateTime.now;
      const started = yield* orchestrator.getThreadProjection(threadId);
      const run = started.runs[0]!;
      const attempt = started.attempts[0]!;
      const providerThreadId = run.providerThreadId!;
      const providerTurnId = ProviderTurnId.make("provider-turn:stop-completed-turn");
      const apply = (event: Omit<OrchestrationV2DomainEvent, "id" | "threadId">) =>
        projections.apply({
          ...event,
          id: EventId.make(`event:stop-completed-turn:${event.type}`),
          threadId,
        } as OrchestrationV2DomainEvent);
      yield* apply({
        type: "run.updated",
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "running", startedAt: now, activeAttemptId: attempt.id },
      });
      yield* apply({
        type: "run-attempt.updated",
        occurredAt: now,
        payload: { ...attempt, status: "completed", startedAt: now, completedAt: now },
      });
      yield* apply({
        type: "provider-turn.updated",
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId: run.rootNodeId!,
          runAttemptId: attempt.id,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      // The provider session was already released.
      yield* apply({
        type: "provider-thread.updated",
        occurredAt: now,
        payload: {
          ...started.providerThreads.find((thread) => thread.id === providerThreadId)!,
          providerSessionId: ProviderSessionId.make("session:gone"),
        },
      });
      yield* send(threadId, "follow", "queue_after_active");

      if (action === "Stop") {
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-completed-turn"),
          threadId,
        });
      } else {
        const threads = yield* ThreadManagementService.ThreadManagementService;
        yield* threads.forceStopThread({ threadId });
      }
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      assert.notEqual(stopped.runs[0]?.status, "running", "the stopped run is still running");
      assert.deepInclude(stopped.attempts[0], { status: "completed", completedAt: now });
      assert.isTrue(
        stopped.turnItems.some((item) => item.type === "run_interrupt_result"),
        "the stopped run has no interrupt result",
      );
    }).pipe(Effect.provide(layerTest)),
);

