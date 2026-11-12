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















it.effect("cancels workflow members and child roots without run ids after restart", () => {
  const parentThreadId = ThreadId.make("thread_recovery_workflow_members");
  const childThreadId = ThreadId.make("thread_recovery_workflow_member_child");
  const memberId = NodeId.make("node_recovery_workflow_member");
  const childRootId = NodeId.make("node_recovery_workflow_member_root");
  const providerInstanceId = ProviderInstanceId.make("claudeAgent");
  const driver = ProviderDriverKind.make("claudeAgent");
  const member = {
    id: memberId,
    threadId: parentThreadId,
    runId: null,
    origin: "provider_native",
    status: "running",
    driver,
    providerInstanceId,
  };
  const parentProjection = {
    thread: { id: parentThreadId, providerInstanceId },
    runs: [],
    attempts: [],
    nodes: [
      { id: memberId, threadId: parentThreadId, runId: null, kind: "subagent", status: "running" },
    ],
    subagents: [member],
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const childProjection = {
    ...parentProjection,
    thread: { id: childThreadId, providerInstanceId },
    nodes: [
      {
        id: childRootId,
        threadId: childThreadId,
        runId: null,
        kind: "root_turn",
        status: "running",
      },
    ],
    subagents: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const committed: Array<Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]> = [];
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([parentThreadId, childThreadId]),
          getRuntimeRecoveryProjection: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committed.push(input);
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
    assert.deepEqual(
      committed.flatMap((command) =>
        command.events.map((event) => [
          command.threadId,
          event.type,
          "status" in event.payload ? event.payload.status : null,
        ]),
      ),
      [
        [parentThreadId, "subagent.updated", "cancelled"],
        [parentThreadId, "node.updated", "cancelled"],
        [childThreadId, "node.updated", "cancelled"],
      ],
    );
  }).pipe(Effect.provide(layer));
});

