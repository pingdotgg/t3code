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



















it.effect.each(["missing session", "completed", "failed", "cancelled"] as const)(
  "a native child Stop only settles a confirmed %s outcome and preserves its owner and sibling",
  (providerState) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:native-child-stop");
      yield* createWatchingThread(threadId, 20);
      yield* send(threadId, "owner", "start_immediately");
      yield* delegate(threadId, "native-child-fixture");
      const before = yield* orchestrator.getThreadProjection(threadId);
      const run = before.runs[0]!;
      const now = yield* DateTime.now;
      const subagent = {
        ...before.subagents[0]!,
        origin: "provider_native" as const,
        driver: CLAUDE_PROVIDER,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        nativeTaskRef: {
          driver: CLAUDE_PROVIDER,
          nativeId: "claude-task",
          strength: "strong" as const,
        },
        status: "running" as const,
        startedAt: now,
      };
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:agent"),
        type: "subagent.updated",
        threadId,
        runId: run.id,
        nodeId: subagent.id,
        occurredAt: now,
        payload: subagent,
      });
      const sibling = {
        ...subagent,
        id: NodeId.make("node:native-stop-sibling"),
        childThreadId: null,
      };
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:sibling"),
        type: "subagent.updated",
        threadId,
        runId: run.id,
        nodeId: sibling.id,
        occurredAt: now,
        payload: sibling,
      });
      const item = before.turnItems.find(
        (item) => item.type === "subagent" && item.subagentId === subagent.id,
      )!;
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:item"),
        type: "turn-item.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...item, status: "running", completedAt: null },
      });
      const childRoot = {
        ...before.nodes.find((node) => node.id === run.rootNodeId)!,
        id: NodeId.make("node:native-stop-child-root"),
        threadId: subagent.childThreadId!,
        runId: null,
        parentNodeId: null,
        status: "running" as const,
        countsForRun: false,
        completedAt: null,
      };
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:child-root"),
        type: "node.updated",
        threadId: childRoot.threadId,
        nodeId: childRoot.id,
        occurredAt: now,
        payload: childRoot,
      });
      const childTurnId = ProviderTurnId.make("turn:native-stop-child");
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:child-turn"),
        type: "provider-turn.updated",
        threadId: childRoot.threadId,
        nodeId: childRoot.id,
        occurredAt: now,
        payload: {
          id: childTurnId,
          providerThreadId: ProviderThreadId.make("provider-thread:native-stop-child"),
          nodeId: childRoot.id,
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      });
      const providerThread = before.providerThreads.find(
        (thread) => thread.id === run.providerThreadId,
      )!;
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:provider-thread"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...providerThread,
          driver: CLAUDE_PROVIDER,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          providerSessionId: ProviderSessionId.make("session:native-child-stop"),
        },
      });
      const providerTurnId = ProviderTurnId.make("turn:native-child-stop");
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:provider-turn"),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId: providerThread.id,
          nodeId: run.rootNodeId!,
          runAttemptId: run.activeAttemptId!,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:owner-completed"),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "completed", startedAt: now, completedAt: now },
      });
      yield* send(threadId, "queued", "queue_after_active");
      const stateBefore = yield* threadState(threadId);
      const eventStore = yield* EventStore.EventStoreV2;
      const afterSequence = yield* eventStore.latestSequence({ threadId });
      const confirmedStatus =
        providerState === "completed" || providerState === "failed" || providerState === "cancelled"
          ? providerState
          : null;
      const confirmedOutcome =
        confirmedStatus === null
          ? undefined
          : { status: confirmedStatus, completedAt: now, result: "Actual provider outcome" };
      const commandId = CommandId.make("stop-native-child");
      yield* orchestrator.dispatch({
        type: "subagent.stop",
        commandId,
        threadId,
        runId: run.id,
        subagentId: subagent.id,
      });
      assert.deepEqual(yield* threadState(threadId), stateBefore);
      const effects = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_effect_outbox WHERE command_id = ${commandId}
    `;
      assert.equal(effects.length, 1);
      assert.deepEqual(JSON.parse(effects[0]!.payload_json), {
        type: "provider-turn.interrupt",
        providerSessionId: "session:native-child-stop",
        providerThreadId: providerThread.id,
        providerTurnId,
        subagent: { id: subagent.id, nativeTaskId: "claude-task" },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).subagents[0]?.status,
        "running",
      );
      const unrelated = yield* Effect.exit(
        orchestrator.dispatch({
          type: "subagent.stop",
          commandId: CommandId.make("stop-unknown-child"),
          threadId,
          runId: run.id,
          subagentId: NodeId.make("unknown-child"),
        }),
      );
      assert.isTrue(Exit.isFailure(unrelated));
      yield* TestClock.adjust("1 second");
      yield* sql`DELETE FROM orchestration_v2_effect_outbox WHERE command_id != ${commandId}`;
      if (providerState === "missing session") {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* worker.drain();
      } else {
        yield* orchestrator.dispatch({
          type: "thread.background-work.settle",
          commandId: CommandId.make("repair-native-child"),
          threadId,
          providerThreadId: providerThread.id,
          providerTurnId,
          subagent: { id: subagent.id, stoppedAt: now, outcome: confirmedOutcome! },
        });
      }
      const settled = yield* orchestrator.getThreadProjection(threadId);
      const cancelled = settled.subagents.find((task) => task.id === subagent.id)!;
      if (confirmedOutcome === undefined) {
        const events = yield* eventStore.read({ threadId, afterSequence }).pipe(Stream.runCollect);
        assert.isFalse(
          events.some(
            ({ event }) =>
              (event.type === "subagent.updated" ||
                event.type === "node.updated" ||
                event.type === "turn-item.updated") &&
              ["completed", "failed", "cancelled", "interrupted"].includes(event.payload.status),
          ),
        );
        assert.equal(cancelled.status, "running");
        assert.equal(
          (yield* orchestrator.getThreadProjection(childRoot.threadId)).nodes.find(
            (node) => node.id === childRoot.id,
          )?.status,
          "running",
        );
        assert.deepEqual(yield* threadState(threadId), stateBefore);
        return;
      }

      const repaired = yield* eventStore.read({ threadId, afterSequence }).pipe(Stream.runCollect);
      const terminal = repaired.flatMap(({ event }) =>
        (event.type === "subagent.updated" ||
          event.type === "node.updated" ||
          event.type === "turn-item.updated") &&
        event.payload.status === confirmedStatus
          ? [event]
          : [],
      );
      assert.deepEqual(terminal.map((event) => event.type).sort(), [
        "node.updated",
        "subagent.updated",
        "turn-item.updated",
      ]);
      for (const event of terminal) {
        assert.equal(event.nodeId, subagent.id);
        assert.equal(
          DateTime.toEpochMillis(event.payload.completedAt!),
          DateTime.toEpochMillis(confirmedOutcome!.completedAt),
        );
        if (event.type === "subagent.updated" || event.type === "turn-item.updated") {
          assert.isDefined(event.payload.updatedAt);
        }
      }

      assert.equal(cancelled.status, confirmedStatus);
      assert.isNotNull(cancelled.completedAt);
      assert.equal(
        DateTime.toEpochMillis(cancelled.completedAt!),
        DateTime.toEpochMillis(confirmedOutcome!.completedAt),
      );
      assert.equal(cancelled.result, confirmedOutcome!.result);
      assert.equal(
        settled.turnItems.find((candidate) => candidate.id === item.id)?.status,
        confirmedStatus,
      );
      const child = yield* orchestrator.getThreadProjection(childRoot.threadId);
      assert.equal(child.nodes.find((node) => node.id === childRoot.id)?.status, confirmedStatus);
      assert.equal(
        child.providerTurns.find((turn) => turn.id === childTurnId)?.status,
        confirmedStatus,
      );
      assert.isNotNull(child.nodes.find((node) => node.id === childRoot.id)?.completedAt);
      assert.equal(settled.subagents.find((task) => task.id === sibling.id)?.status, "running");
      assert.deepEqual(yield* threadState(threadId), stateBefore);
      yield* TestClock.adjust("1 second");
      const resumedAt = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:resume"),
        type: "subagent.updated",
        threadId,
        runId: run.id,
        nodeId: subagent.id,
        occurredAt: resumedAt,
        payload: { ...cancelled, status: "running", startedAt: resumedAt, completedAt: null },
      });
      yield* orchestrator.dispatch({
        type: "thread.background-work.settle",
        commandId: CommandId.make("old-stop-after-resume"),
        threadId,
        providerThreadId: providerThread.id,
        providerTurnId,
        subagent: { id: subagent.id, stoppedAt: now, outcome: confirmedOutcome },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (task) => task.id === subagent.id,
        )?.status,
        "running",
      );
    }).pipe(Effect.provide(layerTest)),
);

