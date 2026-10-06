import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeSubagentChildThread } from "./SubagentProjection.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapterV2Shape;
const layerDatabase = SqlitePersistence.layerMemory;
const layerControls = Layer.mergeAll(
  ThreadCommandExecutor.layer,
  IdAllocator.layer,
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const layerTest = Layer.merge(
  layerControls,
  ProviderEventIngestor.layer.pipe(Layer.provide(layerControls)),
);

it.effect("interrupts only the selected running native Codex subagent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const parentThreadId = ThreadId.make("parent:stop-subagent");
    const childThreadId = ThreadId.make("child:stop-subagent");
    const subagentId = NodeId.make("subagent:stop-subagent");
    const providerThreadId = ProviderThreadId.make("provider-thread:stop-subagent");
    const providerTurnId = ProviderTurnId.make("provider-turn:stop-subagent");
    const providerSessionId = ProviderSessionId.make("session:stop-subagent");
    const now = yield* DateTime.now;
    for (const threadId of [parentThreadId, childThreadId]) {
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:stop-subagent"),
        title: "Agent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    }
    yield* projections.apply({
      id: EventId.make("child:stop-subagent:lineage"),
      type: "thread.metadata-updated",
      threadId: childThreadId,
      occurredAt: now,
      payload: makeSubagentChildThread({
        parentThread: yield* projections.getThread(parentThreadId),
        childThreadId,
        parentNodeId: subagentId,
        activeProviderThreadId: providerThreadId,
        providerInstanceId: instanceId,
        modelSelection,
        title: "Worker",
        now,
        createdBy: "agent",
        creationSource: "provider",
      }),
    });
    const subagent = {
      id: subagentId,
      threadId: parentThreadId,
      runId: null,
      parentNodeId: NodeId.make("root:stop-subagent"),
      origin: "provider_native" as const,
      createdBy: "agent" as const,
      driver: adapter.driver,
      providerInstanceId: instanceId,
      providerThreadId: null,
      childThreadId,
      nativeTaskRef: null,
      prompt: "Check this",
      title: "Worker",
      model: "gpt-5.1-codex",
      status: "running" as const,
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };
    yield* projections.apply({
      id: EventId.make("subagent:stop-subagent"),
      type: "subagent.updated",
      threadId: parentThreadId,
      occurredAt: now,
      payload: subagent,
    });
    const providerThread = {
      id: providerThreadId,
      driver: adapter.driver,
      providerInstanceId: instanceId,
      providerSessionId,
      appThreadId: childThreadId,
      ownerNodeId: subagentId,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    } as const;
    yield* projections.apply({
      id: EventId.make("provider-thread:stop-subagent"),
      type: "provider-thread.updated",
      threadId: childThreadId,
      occurredAt: now,
      payload: providerThread,
    });
    const providerTurn = {
      id: providerTurnId,
      providerThreadId,
      nodeId: NodeId.make("root:child-stop-subagent"),
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running",
      startedAt: now,
      completedAt: null,
    } as const;
    yield* projections.apply({
      id: EventId.make("provider-turn:stop-subagent"),
      type: "provider-turn.updated",
      threadId: childThreadId,
      occurredAt: now,
      payload: providerTurn,
    });
    for (const [threadId, nodeId, kind] of [
      [parentThreadId, subagentId, "subagent"],
      [childThreadId, providerTurn.nodeId, "root_turn"],
    ] as const) {
      yield* projections.apply({
        id: EventId.make(`node:${nodeId}`),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: nodeId,
          threadId,
          runId: null,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind,
          status: "running",
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      });
    }
    const item = {
      id: TurnItemId.make("item:stop-subagent"),
      threadId: parentThreadId,
      runId: null,
      nodeId: subagentId,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running" as const,
      title: subagent.title,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "subagent" as const,
      subagentId,
      origin: subagent.origin,
      driver: subagent.driver,
      providerInstanceId: instanceId,
      childThreadId,
      prompt: subagent.prompt,
      result: null,
    };
    yield* projections.apply({
      id: EventId.make("item:stop-subagent"),
      type: "turn-item.updated",
      threadId: parentThreadId,
      occurredAt: now,
      payload: item,
    });
    yield* projections.apply({
      id: EventId.make("command:stop-subagent"),
      type: "turn-item.updated",
      threadId: childThreadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("command:stop-subagent"),
        threadId: childThreadId,
        runId: null,
        nodeId: providerTurn.nodeId,
        providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "command_execution",
        input: "sleep 100",
      },
    });
    yield* projections.apply({
      id: EventId.make("message:stop-subagent"),
      type: "message.updated",
      threadId: childThreadId,
      occurredAt: now,
      payload: {
        id: MessageId.make("message:stop-subagent"),
        threadId: childThreadId,
        runId: null,
        nodeId: providerTurn.nodeId,
        role: "assistant",
        text: "Working",
        attachments: [],
        streaming: true,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* projections.apply({
      id: EventId.make("request:stop-subagent"),
      type: "runtime-request.updated",
      threadId: childThreadId,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make("request:stop-subagent"),
        nodeId: providerTurn.nodeId,
        providerTurnId,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "live", providerSessionId },
        createdAt: now,
        resolvedAt: null,
      },
    });
    const commandId = CommandId.make("interrupt:stop-subagent");
    const accepted = yield* orchestrator.dispatch({
      type: "subagent.interrupt",
      commandId,
      threadId: parentThreadId,
      subagentId,
    });
    assert.deepEqual(
      accepted.storedEvents.map((event) => event.event.type),
      ["subagent.interrupt-requested"],
    );
    assert.equal(
      (yield* projections.getThreadProjection(parentThreadId)).subagents[0]?.status,
      "running",
    );
    assert.deepEqual(
      (yield* outbox.listByCommandId(commandId)).map(({ threadId, request }) => ({
        threadId,
        request,
      })),
      [
        {
          threadId: childThreadId,
          request: {
            type: "provider-turn.interrupt",
            providerSessionId,
            providerThreadId,
            providerTurnId,
          },
        },
      ],
    );
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* worker.drain();
    const child = yield* projections.getThreadProjection(childThreadId);
    const parent = yield* projections.getThreadProjection(parentThreadId);
    assert.equal(child.providerTurns[0]?.status, "interrupted");
    assert.equal(child.providerThreads[0]?.status, "idle");
    assert.equal(child.nodes[0]?.status, "interrupted");
    assert.equal(child.turnItems[0]?.status, "interrupted");
    assert.equal(child.messages[0]?.streaming, false);
    assert.equal(child.runtimeRequests[0]?.status, "cancelled");
    assert.equal(parent.subagents[0]?.status, "interrupted");
    assert.equal(parent.nodes[0]?.status, "interrupted");
    assert.equal(parent.turnItems[0]?.status, "interrupted");
    const eventSink = yield* EventSink.EventSinkV2;
    const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    for (const order of ["completion-first", "settlement-first"] as const) {
      for (const event of [
        { type: "provider-turn.updated", threadId: childThreadId, payload: providerTurn },
        { type: "subagent.updated", threadId: parentThreadId, payload: subagent },
        {
          type: "node.updated",
          threadId: parentThreadId,
          payload: { ...parent.nodes[0]!, status: "running", completedAt: null },
        },
        { type: "turn-item.updated", threadId: parentThreadId, payload: item },
      ] as const) {
        yield* projections.apply({
          ...event,
          id: EventId.make(`reset:${order}:${event.type}`),
          occurredAt: now,
        });
      }
      const settleCommandId = CommandId.make(`settle:${order}`);
      const reachedCommit = yield* Deferred.make<void>();
      const releaseCommit = yield* Deferred.make<void>();
      const providerQueued = yield* Deferred.make<void>();
      const commitCommand = eventSink.commitCommand;
      const writeWithEffects = eventSink.writeWithEffects;
      const withLock = executor.withLock;
      let parentWritesQueued = 0;
      const commitSpy = vi
        .spyOn(eventSink, "commitCommand")
        .mockImplementation((input) =>
          order === "completion-first" && input.commandId === settleCommandId
            ? Deferred.succeed(reachedCommit, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCommit)),
                Effect.andThen(commitCommand(input)),
              )
            : commitCommand(input),
        );
      const writeSpy = vi
        .spyOn(eventSink, "writeWithEffects")
        .mockImplementation((input) =>
          order === "settlement-first" &&
          input.events.some((event) => event.type === "subagent.updated")
            ? Deferred.succeed(reachedCommit, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCommit)),
                Effect.andThen(writeWithEffects(input)),
              )
            : writeWithEffects(input),
        );
      const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
        key,
        effect,
      ) =>
        key === parentThreadId && ++parentWritesQueued === 4
          ? Deferred.succeed(providerQueued, undefined).pipe(Effect.andThen(withLock(key, effect)))
          : withLock(key, effect);
      const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
      yield* Effect.gen(function* () {
        const settle = yield* orchestrator
          .dispatch({
            type: "thread.background-work.settle",
            commandId: settleCommandId,
            threadId: childThreadId,
            providerThreadId,
            providerTurnId,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.raceFirst(
          Deferred.await(reachedCommit),
          Fiber.join(settle).pipe(
            Effect.andThen(Effect.die("Settlement bypassed the commit barrier.")),
          ),
        );
        const completions = [
          {
            type: "subagent.updated",
            driver: adapter.driver,
            subagent: {
              ...subagent,
              status: "completed",
              completedAt: now,
              completionWake: "always",
            },
          },
          {
            type: "node.updated",
            driver: adapter.driver,
            node: { ...parent.nodes[0]!, status: "completed", completedAt: now },
          },
          {
            type: "turn_item.updated",
            driver: adapter.driver,
            turnItem: { ...item, status: "completed", completedAt: now, result: "Done" },
          },
        ] as const;
        const complete = Effect.forEach(
          completions,
          (event) =>
            ingestor.ingestNormalized({
              providerSessionId,
              providerInstanceId: instanceId,
              threadId: parentThreadId,
              event,
            }),
          { concurrency: "unbounded" },
        );
        if (order === "completion-first") {
          yield* complete;
          yield* Deferred.succeed(releaseCommit, undefined);
          yield* Fiber.join(settle);
        } else {
          const completion = yield* complete.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.raceFirst(
            Deferred.await(providerQueued),
            Fiber.join(completion).pipe(
              Effect.andThen(Effect.die("Provider updates bypassed the parent lock.")),
            ),
          );
          yield* Deferred.succeed(releaseCommit, undefined);
          yield* Fiber.join(settle);
          yield* Fiber.join(completion);
        }
        const completedParent = yield* projections.getThreadProjection(parentThreadId);
        assert.equal(completedParent.subagents[0]?.status, "completed");
        assert.equal(completedParent.subagents[0]?.completionWake, "always");
        assert.equal(completedParent.nodes[0]?.status, "completed");
        assert.equal(completedParent.turnItems[0]?.status, "completed");
        assert.equal(
          completedParent.turnItems[0]?.type === "subagent" && completedParent.turnItems[0].result,
          "Done",
        );
        assert.equal(
          (yield* projections.getThreadProjection(childThreadId)).providerTurns[0]?.status,
          "interrupted",
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            commitSpy.mockRestore();
            writeSpy.mockRestore();
            lockSpy.mockRestore();
          }),
        ),
      );
    }
    for (const race of [
      "completed-turn",
      "completed-task",
      "waiting-task",
      "newer-turn",
    ] as const) {
      yield* projections.apply({
        id: EventId.make(`turn:${race}:running`),
        type: "provider-turn.updated",
        threadId: childThreadId,
        occurredAt: now,
        payload: providerTurn,
      });
      yield* projections.apply({
        id: EventId.make(`task:${race}:running`),
        type: "subagent.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: subagent,
      });
      yield* projections.apply({
        id: EventId.make(`provider-thread:${race}:active`),
        type: "provider-thread.updated",
        threadId: childThreadId,
        occurredAt: now,
        payload: providerThread,
      });
      yield* orchestrator.dispatch({
        type: "subagent.interrupt",
        commandId: CommandId.make(`interrupt:${race}`),
        threadId: parentThreadId,
        subagentId,
      });
      const newerTurnId = ProviderTurnId.make("turn:stop-subagent:newer");
      if (race === "completed-turn" || race === "newer-turn") {
        yield* projections.apply({
          id: EventId.make(`turn:${race}:raced`),
          type: "provider-turn.updated",
          threadId: childThreadId,
          occurredAt: now,
          payload:
            race === "newer-turn"
              ? { ...providerTurn, id: newerTurnId, ordinal: 2 }
              : { ...providerTurn, status: "completed", completedAt: now },
        });
      }
      if (race !== "newer-turn") {
        yield* projections.apply({
          id: EventId.make(`task:${race}:completed`),
          type: "subagent.updated",
          threadId: parentThreadId,
          occurredAt: now,
          payload: {
            ...subagent,
            status: race === "waiting-task" ? "waiting" : "completed",
            completedAt: race === "waiting-task" ? null : now,
          },
        });
      }
      yield* worker.drain();
      const racedChild = yield* projections.getThreadProjection(childThreadId);
      assert.equal(
        racedChild.providerTurns.find((turn) => turn.id === providerTurnId)?.status,
        race === "completed-turn" ? "completed" : "interrupted",
      );
      assert.equal(
        (yield* projections.getThreadProjection(parentThreadId)).subagents[0]?.status,
        race === "newer-turn" ? "running" : race === "waiting-task" ? "interrupted" : "completed",
      );
      if (race === "newer-turn") {
        assert.equal(
          racedChild.providerTurns.find((turn) => turn.id === newerTurnId)?.status,
          "running",
        );
        assert.equal(racedChild.providerThreads[0]?.status, "active");
        yield* projections.apply({
          id: EventId.make("turn:newer:completed"),
          type: "provider-turn.updated",
          threadId: childThreadId,
          occurredAt: now,
          payload: {
            ...providerTurn,
            id: newerTurnId,
            ordinal: 2,
            status: "completed",
            completedAt: now,
          },
        });
      }
    }
    yield* projections.apply({
      id: EventId.make("subagent:stop-subagent:running"),
      type: "subagent.updated",
      threadId: parentThreadId,
      occurredAt: now,
      payload: subagent,
    });
    for (const missing of ["turn", "session"] as const) {
      yield* projections.apply({
        id: EventId.make(`provider-turn:stop-subagent:missing-${missing}`),
        type: "provider-turn.updated",
        threadId: childThreadId,
        occurredAt: now,
        payload: {
          ...providerTurn,
          status: missing === "turn" ? "completed" : "running",
          completedAt: missing === "turn" ? now : null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`provider-thread:stop-subagent:missing-${missing}`),
        type: "provider-thread.updated",
        threadId: childThreadId,
        occurredAt: now,
        payload: {
          ...providerThread,
          providerSessionId: missing === "session" ? null : providerSessionId,
        },
      });
      const rejectedCommandId = CommandId.make(`interrupt:stop-subagent:missing-${missing}`);
      const rejected = yield* orchestrator
        .dispatch({
          type: "subagent.interrupt",
          commandId: rejectedCommandId,
          threadId: parentThreadId,
          subagentId,
        })
        .pipe(Effect.flip);
      assert.instanceOf(rejected, Orchestrator.OrchestratorDispatchError);
      assert.equal(
        rejected.cause,
        `Child thread ${childThreadId} for subagent ${subagentId} has no running provider turn or provider session.`,
      );
      assert.deepEqual(yield* outbox.listByCommandId(rejectedCommandId), []);
    }
    yield* projections.apply({
      id: EventId.make("subagent:stop-subagent:completed"),
      type: "subagent.updated",
      threadId: parentThreadId,
      occurredAt: now,
      payload: { ...subagent, status: "completed", completedAt: now },
    });
    const settledCommandId = CommandId.make("interrupt:stop-subagent:settled");
    const rejected = yield* orchestrator
      .dispatch({
        type: "subagent.interrupt",
        commandId: settledCommandId,
        threadId: parentThreadId,
        subagentId,
      })
      .pipe(Effect.flip);
    assert.instanceOf(rejected, Orchestrator.OrchestratorDispatchError);
    assert.equal(
      rejected.cause,
      `Subagent ${subagentId} is not a running native Codex subagent with a child thread.`,
    );
    assert.deepEqual(yield* outbox.listByCommandId(settledCommandId), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "dispatches metadata, queue resume and request controls without hydrating unrelated history",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:control-dispatch");
      const now = yield* DateTime.now;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-control"),
        threadId,
        projectId: ProjectId.make("project:control-dispatch"),
        title: "Before",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      for (const enabled of [false, true]) {
        yield* orchestrator.dispatch({
          type: "thread.auto-settle.set",
          commandId: CommandId.make(`auto-settle-${enabled}`),
          threadId,
          enabled,
        });
        const updated = yield* projections.getThreadProjection(threadId);
        assert.equal(updated.thread.autoSettleDisabledAt == null, enabled);
        const shell = yield* projections.getThreadShell(threadId);
        assert.ok(shell);
        assert.equal(shell.autoSettleDisabledAt == null, enabled);
      }
      yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('obsolete', ${threadId}, NULL, NULL, 'assistant', 0, ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      assert.equal((yield* Effect.exit(projections.getThreadProjection(threadId)))._tag, "Failure");
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-empty-queue"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename-control"),
        threadId,
        title: "After",
      });
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("mode-control"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("model-control"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-6" },
      });
      const sessionId = ProviderSessionId.make("session:control-dispatch");
      yield* projections.apply({
        id: EventId.make("attach-control"),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: "gpt-6",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      for (const mode of ["live", "message"] as const) {
        const requestId = RuntimeRequestId.make(`request:${mode}`);
        yield* projections.apply({
          id: EventId.make(`request:${mode}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId: NodeId.make(`node:${mode}`),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability:
              mode === "live"
                ? { type: "live", providerSessionId: sessionId }
                : { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        });
        const nodeId = NodeId.make(`node:${mode}`);
        yield* projections.apply({
          id: EventId.make(`node:${mode}`),
          type: "node.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        });
        yield* projections.apply({
          id: EventId.make(`item:${mode}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${mode}`),
            threadId,
            runId: null,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: mode === "live" ? 1 : 2,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "user_input_request",
            requestId,
            questions: [],
          },
        });
        yield* orchestrator.dispatch(
          mode === "live"
            ? {
                type: "runtime-request.respond",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
                decision: "accept",
              }
            : {
                type: "thread.user-input.dismiss",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
              },
        );
        assert.equal(
          (yield* projections.getRuntimeRequest(threadId, requestId))?.status,
          "resolved",
        );
        const response = yield* projections.getRuntimeResponseContext(threadId, requestId);
        assert.equal(response.node?.status, mode === "live" ? "completed" : "cancelled");
        assert.equal(response.item?.status, mode === "live" ? "completed" : "cancelled");
      }
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("workspace-control"),
        threadId,
        worktreePath: "/new-repo",
      });
      const thread = yield* projections.getThread(threadId);
      assert.equal(thread.title, "After");
      assert.equal(thread.modelSelection.model, "gpt-6");
      assert.equal(thread.runtimeMode, "approval-required");
      assert.deepEqual(
        (yield* projections.getThreadProviderContext(threadId)).providerSessions,
        [],
      );
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          type, status, ordinal, updated_at, payload_json)
        VALUES ('obsolete-output', ${threadId}, NULL, NULL, NULL, NULL,
          'command_execution', 'completed', 900, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_plans
        (plan_id, thread_id, run_id, node_id, kind, status, payload_json)
        VALUES ('obsolete-plan', ${threadId}, NULL, 'old-node', 'proposed', 'completed', '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_handoffs
        (context_handoff_id, thread_id, target_run_id, to_provider_thread_id, strategy, status, updated_at, payload_json)
        VALUES ('obsolete-handoff', ${threadId}, 'old-run', 'old-provider-thread', 'full_thread_summary', 'ready', ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("dispatch-with-old-history"),
        threadId,
        messageId: MessageId.make("fresh-input"),
        text: "Continue",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const fresh = yield* projections.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["user_message"],
      });
      assert.isAbove(fresh.turnItems.at(-1)!.ordinal, 900);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-with-old-history"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-with-old-history"),
        threadId,
      });
      assert.isNotNull((yield* projections.getThread(threadId)).deletedAt);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("implements a proposed plan that the command projection leaves out", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:implement-plan");
    const planId = PlanId.make("plan:implement-plan");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-implement-plan"),
      threadId,
      projectId: ProjectId.make("project:implement-plan"),
      title: "Plan",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "plan",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("plan:implement-plan"),
      type: "plan.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: planId,
        threadId,
        runId: null,
        nodeId: NodeId.make("node:implement-plan"),
        kind: "proposed_plan",
        status: "active",
        markdown: "# Plan\n\n1. Do the thing.",
      },
    });

    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("implement-plan"),
      threadId,
      messageId: MessageId.make("implement-plan-input"),
      text: "Implement the plan.",
      attachments: [],
      sourcePlanRef: { threadId, planId },
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });

    assert.equal((yield* projections.getPlan(threadId, planId))?.status, "completed");
  }).pipe(Effect.provide(layerTest)),
);

// Stop's settle follow-up runs after the provider interrupt returns, possibly
// long after the Stop (retries) or again (an effect replayed after a crash).
// A later run's background work is not that Stop's to end.
it.effect("settles only the stopped run's background work, once", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:settle-binding");
    const providerThreadId = ProviderThreadId.make("provider-thread:settle-binding");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-settle-binding"),
      threadId,
      projectId: ProjectId.make("project:settle-binding"),
      title: "Settle binding",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("settle-binding:provider-thread"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 2,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    const commandItem = (ordinal: number) => TurnItemId.make(`turn-item:settle-binding:${ordinal}`);
    for (const ordinal of [1, 2]) {
      const runId = RunId.make(`run:settle-binding:${ordinal}`);
      const attemptId = RunAttemptId.make(`attempt:settle-binding:${ordinal}`);
      const nodeId = NodeId.make(`node:settle-binding:${ordinal}`);
      const providerTurnId = ProviderTurnId.make(`provider-turn:settle-binding:${ordinal}`);
      yield* projections.apply({
        id: EventId.make(`settle-binding:run:${ordinal}`),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`message:settle-binding:${ordinal}`),
          rootNodeId: nodeId,
          activeAttemptId: attemptId,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:attempt:${ordinal}`),
        type: "run-attempt.created",
        threadId,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId: instanceId,
          providerThreadId,
          providerTurnId,
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:turn:${ordinal}`),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:item:${ordinal}`),
        type: "turn-item.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: commandItem(ordinal),
          threadId,
          runId,
          nodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinal * 10,
          status: "running",
          title: `Background command ${ordinal}`,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: `sleep ${ordinal}`,
        },
      });
    }
    const itemStatuses = Effect.map(projections.getThreadProjection(threadId), (projection) =>
      projection.turnItems
        .flatMap((item) => (item.type === "command_execution" ? [`${item.id}:${item.status}`] : []))
        .toSorted(),
    );
    // The settle that followed a Stop of run 1's turn, dispatched only after
    // run 2 had settled with work of its own.
    const settle = {
      type: "thread.background-work.settle",
      commandId: CommandId.make("stop-run-1:background-work-settled"),
      threadId,
      providerThreadId,
      providerTurnId: ProviderTurnId.make("provider-turn:settle-binding:1"),
    } as const;
    yield* orchestrator.dispatch(settle);
    assert.deepEqual(yield* itemStatuses, [
      `${commandItem(1)}:interrupted`,
      `${commandItem(2)}:running`,
    ]);

    // A settle that found nothing to end replays as a no-op, even after work
    // it would match appears: its receipt is recorded with no events.
    const emptySettle = {
      ...settle,
      commandId: CommandId.make("stop-run-1-again:background-work-settled"),
    };
    const first = yield* orchestrator.dispatch(emptySettle);
    assert.lengthOf(first.storedEvents, 0);
    yield* projections.apply({
      id: EventId.make("settle-binding:item:late"),
      type: "turn-item.updated",
      threadId,
      runId: RunId.make("run:settle-binding:1"),
      occurredAt: now,
      payload: {
        id: commandItem(3),
        threadId,
        runId: RunId.make("run:settle-binding:1"),
        nodeId: NodeId.make("node:settle-binding:1"),
        providerThreadId,
        providerTurnId: ProviderTurnId.make("provider-turn:settle-binding:1"),
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 30,
        status: "running",
        title: "Late background command",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "command_execution",
        input: "sleep 3",
      },
    });
    const replayed = yield* orchestrator.dispatch(emptySettle);
    assert.lengthOf(replayed.storedEvents, 0);
    assert.deepEqual(yield* itemStatuses, [
      `${commandItem(1)}:interrupted`,
      `${commandItem(2)}:running`,
      `${commandItem(3)}:running`,
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps delegated child pull-request links independent of the parent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parentThreadId = ThreadId.make("thread:parent-pr");
    const projectId = ProjectId.make("project:parent-pr");
    const parentPullRequest = {
      projectId,
      repository: "pingdotgg/t3code",
      number: 123,
      url: "https://github.com/pingdotgg/t3code/pull/123",
    };
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-parent-pr"),
      threadId: parentThreadId,
      projectId,
      title: "Parent with a linked PR",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/parent-pr",
      worktreePath: "/repo-worktree",
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("link-parent-pr"),
      threadId: parentThreadId,
      linkedPullRequest: parentPullRequest,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-parent-pr"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:parent-pr"),
      text: "Delegate a review",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parent = yield* projections.getThreadProjection(parentThreadId);
    const parentRun = parent.runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-parent-pr"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Review the changes",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const updatedParent = yield* projections.getThreadProjection(parentThreadId);
    const childThreadId = updatedParent.subagents[0]!.childThreadId!;
    const child = yield* projections.getThreadProjection(childThreadId);
    assert.isNull(child.thread.linkedPullRequest);
    assert.deepEqual(child.thread.pullRequests, []);
    assert.equal(child.thread.branch, parent.thread.branch);
    assert.equal(child.thread.worktreePath, parent.thread.worktreePath);
    assert.equal(child.thread.lineage.parentThreadId, parentThreadId);

    const childPullRequest = {
      ...parentPullRequest,
      number: 456,
      url: "https://github.com/pingdotgg/t3code/pull/456",
    };
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("link-child-pr"),
      threadId: childThreadId,
      linkedPullRequest: childPullRequest,
    });
    const linkedChild = yield* projections.getThreadProjection(childThreadId);
    assert.deepEqual(linkedChild.thread.linkedPullRequest, childPullRequest);
    assert.deepEqual(
      linkedChild.thread.pullRequests?.map((link) => link.number),
      [456],
    );
    const parentAfterChildLink = yield* projections.getThreadProjection(parentThreadId);
    assert.deepEqual(parentAfterChildLink.thread.linkedPullRequest, parentPullRequest);
    assert.deepEqual(parentAfterChildLink.thread.pullRequests, parent.thread.pullRequests);
  }).pipe(Effect.provide(layerTest)),
);
