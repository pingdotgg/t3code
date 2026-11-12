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















it.effect("recovery closes a secret card's form but leaves a link card open", () => {
  const threadId = ThreadId.make("thread_secret_recovery");
  const runId = RunId.make("run_secret_recovery");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [{ id: runId, status: "running", providerInstanceId: ProviderInstanceId.make("codex") }],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [
      {
        id: "turn-item:secret-request:recovery",
        threadId,
        runId,
        nodeId: null,
        type: "secret_request",
        status: "waiting",
        secretStatus: "pending",
        label: "GitHub token",
        reason: "Used as GH_TOKEN.",
      },
      {
        id: "turn-item:link-request:recovery",
        threadId,
        runId,
        nodeId: null,
        type: "link_request",
        status: "waiting",
        linkStatus: "pending",
        url: "https://box.example.ts.net",
        reason: "Run the suite there.",
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
          listByCommandId: () => Effect.succeed([]),
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    const cards = (committedInput?.events ?? []).flatMap((event) =>
      event.type === "turn-item.updated" ? [event.payload] : [],
    );
    const secret = cards.find((card) => card.type === "secret_request");
    assert.equal(secret?.status, "cancelled");
    assert.equal(secret?.type === "secret_request" ? secret.secretStatus : null, "cancelled");
    // Nothing in memory waits on a link card; the user can still answer it.
    assert.equal(
      cards.some((card) => card.type === "link_request"),
      false,
    );
  }).pipe(Effect.provide(layer));
});

