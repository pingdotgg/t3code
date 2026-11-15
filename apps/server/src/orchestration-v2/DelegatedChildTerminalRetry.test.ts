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
const parentThreadId = ThreadId.make("thread:delegated-terminal-retry-parent");
const childError = "Failed to initialize session: No space left on device";

type ParentRead = {
  readonly store: ProjectionStore.ProjectionStoreV2["Service"];
  readonly threadId: ThreadId;
  readonly fields: ReadonlyArray<string>;
  readonly filter: Parameters<ProjectionStore.ProjectionStoreV2["Service"]["getThreadRecords"]>[2];
};

// The parent hears of a child only from the reaction to the child's terminal run.
// The injected failure stands in for a storage error, such as a full disk, and fails once.
const runDelegation = (input: {
  readonly name: string;
  readonly parentEndsFirst: boolean;
  readonly failRead?: (read: ParentRead) => Effect.Effect<boolean>;
  readonly failChildRunMessage?: boolean;
}) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(input.name);
    let armed = false;
    const turns: Array<{
      readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
      readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
    }> = [];
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (session) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          return {
            instanceId,
            driver,
            providerSessionId: session.providerSessionId,
            providerSession: {
              id: session.providerSessionId,
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
                      cause: new Error(childError),
                    }),
                  )
                : Effect.succeed({
                    id: ProviderThreadId.make(`provider-thread:${threadId}`),
                    driver,
                    providerInstanceId: instanceId,
                    providerSessionId: session.providerSessionId,
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
      { name: input.name },
      ProviderAdapterRegistry.layerSingle(adapter),
      {
        runEffectWorker: false,
        runContinuationWorker: true,
        wrapProjectionStore: (store) => ({
          ...store,
          getThreadRecords: (threadId, fields, filter) =>
            Effect.gen(function* () {
              if (
                armed &&
                input.failRead !== undefined &&
                (yield* input.failRead({ store, threadId, fields, filter }))
              ) {
                armed = false;
                return yield* new ProjectionStore.ProjectionStoreReadError({ threadId });
              }
              return yield* store.getThreadRecords(threadId, fields, filter);
            }),
          getRunMessage: (threadId, runId) => {
            if (
              !armed ||
              !input.failChildRunMessage ||
              !IdAllocator.isDelegatedTaskThread(threadId)
            ) {
              return store.getRunMessage(threadId, runId);
            }
            armed = false;
            return Effect.fail(new ProjectionStore.ProjectionStoreReadError({ threadId }));
          },
        }),
      },
    );

    return yield* Effect.gen(function* () {
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

      const endParentTurn = Effect.gen(function* () {
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
      });

      if (input.parentEndsFirst) {
        const parentEnded = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === parentRun.id &&
            event.payload.status !== "running",
        );
        yield* endParentTurn;
        yield* Fiber.join(parentEnded);
      }

      armed = true;
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
      assert.isFalse(armed, "the injected read failed once");

      if (!input.parentEndsFirst) yield* endParentTurn;
      for (let attempt = 0; attempt < 5; attempt++) {
        yield* worker.drain();
        yield* TestClock.adjust("30 seconds");
      }

      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      const settled = parent.subagents.find((row) => row.id === task.id);
      assert.equal(settled?.status, "failed");
      assert.equal(settled?.result, childError);
      assert.isTrue(
        parent.messages.some(
          (message) => message.delegatedCompletion?.taskIds.includes(task.id) === true,
        ),
        "the parent is woken with the child's failure",
      );
    }).pipe(Effect.provide(layerTest));
  });

it.effect("a delegated child that fails to start reaches its parent after a failed read", () =>
  runDelegation({
    name: "delegated-child-terminal-retry",
    parentEndsFirst: false,
    // Only finalizing the parent's task reads its rows by child thread.
    failRead: ({ filter }) => Effect.succeed(filter?.subagentChildThreadIds !== undefined),
  }),
);

it.effect("an idle parent is woken when its wake fails after the task settles", () =>
  runDelegation({
    name: "delegated-child-terminal-wake-retry",
    parentEndsFirst: true,
    failRead: ({ store, threadId, fields, filter }) =>
      threadId !== parentThreadId || fields.join() !== "runs" || filter?.runIds === undefined
        ? Effect.succeed(false)
        : store.getThreadRecords(parentThreadId, ["subagents"]).pipe(
            Effect.map((records) => records.subagents.some((task) => task.result !== null)),
            Effect.orDie,
          ),
  }),
);

it.effect("a delegated child reaches its parent after its own delivery read fails", () =>
  runDelegation({
    name: "delegated-child-terminal-delivery-read",
    parentEndsFirst: false,
    failChildRunMessage: true,
  }),
);
