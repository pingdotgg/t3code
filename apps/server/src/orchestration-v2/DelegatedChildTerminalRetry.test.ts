import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-test" };

// The parent hears of a child only from the reaction to the child's terminal run.
it.effect("a delegated child that fails to start reaches its parent after a failed read", () =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace("delegated-child-terminal-retry");
    const parentThreadId = ThreadId.make("thread:delegated-terminal-retry-parent");
    let failParentTaskRead = false;
    const turns: Array<{
      readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
      readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
    }> = [];
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (input) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          return {
            instanceId,
            driver,
            providerSessionId: input.providerSessionId,
            providerSession: {
              id: input.providerSessionId,
              driver,
              providerInstanceId: instanceId,
              status: "ready",
              cwd,
              model: modelSelection.model,
              capabilities: ClaudeProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events: Stream.fromQueue(events),
            ensureThread: ({ threadId }) =>
              IdAllocator.isDelegatedTaskThread(threadId)
                ? Effect.fail(
                    new ProviderAdapter.ProviderAdapterEnsureThreadError({
                      driver,
                      threadId,
                      cause: new Error("Failed to initialize session: No space left on device"),
                    }),
                  )
                : Effect.succeed({
                    id: ProviderThreadId.make(`provider-thread:${threadId}`),
                    driver,
                    providerInstanceId: instanceId,
                    providerSessionId: input.providerSessionId,
                    appThreadId: threadId,
                    ownerNodeId: null,
                    nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
                    nativeConversationHeadRef: null,
                    status: "idle",
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    forkedFrom: null,
                    createdAt: now,
                    updatedAt: now,
                  }),
            resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
            startTurn: (turn) =>
              Effect.gen(function* () {
                turns.push({ turn, events });
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                    providerThreadId: turn.providerThread.id,
                    nodeId: turn.rootNodeId,
                    runAttemptId: turn.attemptId,
                    nativeTurnRef: null,
                    ordinal: turn.providerTurnOrdinal,
                    status: "running",
                    startedAt: now,
                    completedAt: null,
                  },
                });
              }),
            steerTurn: () => Effect.die("unused"),
            interruptTurn: () => Effect.void,
            respondToRuntimeRequest: () => Effect.die("unused"),
            readThreadSnapshot: () => Effect.die("unused"),
            rollbackThread: () => Effect.die("unused"),
            forkThread: () => Effect.die("unused"),
          };
        }),
    };
    const layerTest = ProviderReplayHarness.layerWithRegistry(
      { name: "delegated-child-terminal-retry" },
      ProviderAdapterRegistry.layerSingle(adapter),
      {
        runEffectWorker: false,
        runContinuationWorker: true,
        // Stands in for a storage error, such as a full disk, while the parent reads the task.
        wrapProjectionStore: (store) => ({
          ...store,
          getThreadRecords: (threadId, fields, filter) => {
            if (!failParentTaskRead || filter?.subagentChildThreadIds === undefined) {
              return store.getThreadRecords(threadId, fields, filter);
            }
            failParentTaskRead = false;
            return Effect.fail(new ProjectionStore.ProjectionStoreReadError({ threadId }));
          },
        }),
      },
    );

    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
        orchestrator.streamDomainEvents.pipe(
          Stream.filter(predicate),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-parent"),
        threadId: parentThreadId,
        projectId: ProjectId.make("project:delegated-terminal-retry"),
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      });
      const parentRunning = yield* watch(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      );
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start-parent"),
        threadId: parentThreadId,
        messageId: MessageId.make("message:start-parent"),
        text: "Delegate a review",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      yield* Fiber.join(parentRunning);
      const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;

      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("delegate"),
        parentThreadId,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        task: "Review the change",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
      const childThreadId = task.childThreadId!;

      // The child fails while the parent's turn still runs, as a session that cannot start does.
      failParentTaskRead = true;
      const childFailed = yield* watch(
        (event) =>
          event.type === "run.updated" &&
          event.payload.threadId === childThreadId &&
          event.payload.status === "failed",
      );
      for (let attempt = 0; attempt < 5; attempt++) {
        yield* worker.drain();
        yield* TestClock.adjust("1 second");
      }
      yield* Fiber.join(childFailed);
      assert.isFalse(failParentTaskRead, "the parent's read of the task failed once");

      const parentTurn = (yield* orchestrator.getThreadProjection(parentThreadId))
        .providerTurns[0]!;
      const parentEvents = turns.find((entry) => entry.turn.threadId === parentThreadId)!.events;
      const now = yield* DateTime.now;
      yield* Queue.offer(parentEvents, {
        type: "provider_turn.updated",
        driver,
        providerTurn: { ...parentTurn, status: "completed", completedAt: now },
      });
      yield* Queue.offer(parentEvents, {
        type: "turn.terminal",
        driver,
        providerThreadId: parentTurn.providerThreadId,
        providerTurnId: parentTurn.id,
        runOrdinal: parentRun.ordinal,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      for (let attempt = 0; attempt < 5; attempt++) {
        yield* worker.drain();
        yield* TestClock.adjust("30 seconds");
      }

      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      const settled = parent.subagents.find((row) => row.id === task.id);
      assert.equal(settled?.status, "failed");
      assert.equal(settled?.result, "Failed to initialize session: No space left on device");
      assert.isTrue(
        parent.messages.some(
          (message) => message.delegatedCompletion?.taskIds.includes(task.id) === true,
        ),
        "the parent is woken with the child's failure",
      );
    }).pipe(Effect.provide(layerTest));
  }),
);
