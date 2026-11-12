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
  "records cancelled work on the provider thread that lost it after a provider switch",
  () => {
    const threadId = ThreadId.make("thread_switch_note");
    const claudeRunId = RunId.make("run_switch_note_claude");
    const codexRunId = RunId.make("run_switch_note_codex");
    const claudeThreadId = ProviderThreadId.make("provider_thread_switch_note_claude");
    const codexThreadId = ProviderThreadId.make("provider_thread_switch_note_codex");
    const claude = ProviderInstanceId.make("claude");
    const codex = ProviderInstanceId.make("codex");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;

    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [],
      providerThreads: [
        {
          id: claudeThreadId,
          ownerNodeId: null,
          driver: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claude,
          status: "idle",
          pendingBackgroundTasks: [{ taskId: "task-claude", description: "Watch the build" }],
        },
        {
          id: codexThreadId,
          ownerNodeId: null,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: codex,
          status: "idle",
        },
      ],
      providerTurns: [],
      runs: [
        {
          id: claudeRunId,
          ordinal: 1,
          status: "completed",
          providerInstanceId: claude,
          providerThreadId: claudeThreadId,
        },
        {
          id: codexRunId,
          ordinal: 2,
          status: "completed",
          providerInstanceId: codex,
          providerThreadId: codexThreadId,
        },
      ],
      attempts: [],
      nodes: [],
      subagents: [],
      messages: [],
      turnItems: [
        {
          id: TurnItemId.make("turn_item_switch_note_subagent"),
          runId: claudeRunId,
          nodeId: null,
          providerThreadId: claudeThreadId,
          nativeItemRef: null,
          type: "subagent",
          title: "Background subagent",
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
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      const recorded = (committedInput?.events ?? []).flatMap((event) =>
        event.type === "run.background-work-cancelled" ? [event.payload] : [],
      );

      assert.deepEqual(
        recorded.map((entry) => ({
          runId: entry.runId,
          kinds: entry.restartCancelledBackgroundWork.map((work) => work.kind),
        })),
        [{ runId: claudeRunId, kinds: ["subagent", "task"] }],
      );
    }).pipe(Effect.provide(layer));
  },
);

