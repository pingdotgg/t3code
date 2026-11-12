import { assert, it, vi } from "@effect/vitest";
import {
  MessageId,
  NodeId,
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
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ServerSettings from "../serverSettings.ts";















it.effect(
  "preserves a replayable waiting run while cancelling its process-bound background work",
  () => {
    const threadId = ThreadId.make("thread_waiting_checkpoint");
    const runId = RunId.make("run_waiting_checkpoint");
    const providerThreadId = ProviderThreadId.make("provider_thread_waiting_checkpoint");
    const providerInstanceId = ProviderInstanceId.make("claude");
    const backgroundItemId = TurnItemId.make("turn_item_waiting_checkpoint");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [],
      providerThreads: [
        {
          id: providerThreadId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId,
          status: "idle",
          pendingBackgroundTasks: [
            { taskId: String(backgroundItemId), description: "Finish background task" },
          ],
        },
      ],
      runs: [{ id: runId, status: "waiting", providerInstanceId, providerThreadId }],
      attempts: [],
      nodes: [],
      subagents: [],
      messages: [],
      turnItems: [
        {
          id: backgroundItemId,
          runId,
          nodeId: null,
          providerThreadId,
          type: "command_execution",
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({
                committed: true,
                cancelledEffectCount: 0,
              } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listByCommandId: () =>
              Effect.succeed([
                {
                  request: { type: "checkpoint.capture", runId },
                  status: "running",
                },
              ] as never),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 1, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const summary =
        yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      assert.equal(summary.terminalizedRuns, 0);
      assert.equal(summary.requeuedEffects, 1);

      const command = committedInput;
      assert.isNotNull(command);
      if (command === null) return;

      assert.isFalse(command.events.some((event) => event.type === "run.updated"));
      const recorded = command.events.flatMap((event) =>
        event.type === "run.background-work-cancelled" ? [event.payload] : [],
      );

      assert.deepEqual(
        recorded.map((entry) => ({
          runId: entry.runId,
          kinds: entry.restartCancelledBackgroundWork.map((work) => work.kind),
        })),
        [{ runId, kinds: ["shell"] }],
      );
      assert.isTrue(
        command.events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.id === backgroundItemId &&
            event.payload.status === "cancelled",
        ),
      );
      assert.isTrue(
        command.events.some(
          (event) =>
            event.type === "provider-thread.updated" &&
            event.payload.id === providerThreadId &&
            event.payload.pendingBackgroundTasks?.length === 0,
        ),
      );
    }).pipe(Effect.provide(layer));
  },
);

