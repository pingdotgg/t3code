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















it.effect("expires orphaned runtime requests before command readiness", () => {
  const threadId = ThreadId.make("thread_recovery_requests");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const committed = vi.fn(
    (input: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]) => {
      committedInput = input;
      return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
    },
  );
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("request_orphaned"),
        nodeId: NodeId.make("node_orphaned"),
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "old process" },
      },
    ],
    providerSessions: [],
    providerThreads: [],
    runs: [],
    nodes: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({ commitCommand: committed }),
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
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).recover;
    const command = committedInput;
    assert.isNotNull(command);
    if (command === null) return;
    assert.equal(command?.events[0]?.type, "runtime-request.updated");
    if (command?.events[0]?.type === "runtime-request.updated") {
      assert.equal(command.events[0].payload.status, "expired");
      assert.equal(command.events[0].payload.responseCapability.type, "not_resumable");
    }
  }).pipe(Effect.provide(layer));
});

