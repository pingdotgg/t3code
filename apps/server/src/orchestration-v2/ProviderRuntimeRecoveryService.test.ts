import { assert, it, vi } from "@effect/vitest";
import {
  NodeId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const { decideProviderRuntimeRecovery } = ProviderRuntimeRecovery;

it("retries process and transport failures only within the idempotent retry budget", () => {
  assert.deepEqual(
    decideProviderRuntimeRecovery({
      kind: "process_exited",
      attempt: 1,
      maxAttempts: 3,
      idempotent: true,
      online: true,
    }),
    { type: "retry_now" },
  );
  assert.equal(
    decideProviderRuntimeRecovery({
      kind: "transport_unavailable",
      attempt: 3,
      maxAttempts: 3,
      idempotent: true,
      online: true,
    }).type,
    "terminalize",
  );
});

it("waits for connectivity and requires retry-after for rate limits", () => {
  assert.deepEqual(
    decideProviderRuntimeRecovery({
      kind: "network_unavailable",
      attempt: 0,
      maxAttempts: 3,
      idempotent: true,
      online: false,
    }),
    { type: "wait_for_connectivity" },
  );
  assert.deepEqual(
    decideProviderRuntimeRecovery({
      kind: "provider_rate_limited",
      attempt: 0,
      maxAttempts: 3,
      idempotent: true,
      retryAfterMs: 250,
      online: true,
    }),
    { type: "retry_after", delayMs: 250 },
  );
});

it("terminalizes non-recoverable provider failures", () => {
  for (const kind of [
    "provider_quota_exceeded",
    "auth_invalid",
    "permission_denied",
    "invalid_request",
    "unsupported_model",
  ] as const) {
    assert.equal(
      decideProviderRuntimeRecovery({
        kind,
        attempt: 0,
        maxAttempts: 3,
        idempotent: true,
        online: true,
      }).type,
      "terminalize",
    );
  }
});

it("classifies wrapped provider failures without provider-name checks", () => {
  assert.deepEqual(
    ProviderRuntimeRecovery.classifyProviderRuntimeFailure({
      _tag: "ProviderSessionOpenError",
      cause: { code: "rate_limit_exceeded", retryAfterMs: 125 },
    }),
    { kind: "provider_rate_limited", retryAfterMs: 125 },
  );
  assert.deepEqual(
    ProviderRuntimeRecovery.classifyProviderRuntimeFailure({
      cause: { status: 401, message: "authentication failed" },
    }),
    { kind: "auth_invalid" },
  );
});

it.effect("executes bounded transport retries and returns the resumed value", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const value = yield* ProviderRuntimeRecovery.recoverWithPolicy({
      operation: Ref.getAndUpdate(attempts, (count) => count + 1).pipe(
        Effect.flatMap((count) =>
          count < 2 ? Effect.fail("transport down") : Effect.succeed("resumed"),
        ),
      ),
      classify: () => ({ kind: "transport_unavailable" }),
      connectivity: { isOnline: Effect.succeed(true), awaitOnline: Effect.void },
      maxAttempts: 3,
      idempotent: true,
    });
    assert.equal(value, "resumed");
    assert.equal(yield* Ref.get(attempts), 3);
  }),
);

it.effect("waits for connectivity before retrying a network failure", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const online = yield* Ref.make(false);
    const waits = yield* Ref.make(0);
    const value = yield* ProviderRuntimeRecovery.recoverWithPolicy({
      operation: Ref.getAndUpdate(attempts, (count) => count + 1).pipe(
        Effect.flatMap((count) =>
          count === 0 ? Effect.fail("offline") : Effect.succeed("resumed"),
        ),
      ),
      classify: () => ({ kind: "network_unavailable" }),
      connectivity: {
        isOnline: Ref.get(online),
        awaitOnline: Ref.set(online, true).pipe(
          Effect.andThen(Ref.update(waits, (count) => count + 1)),
        ),
      },
      maxAttempts: 3,
      idempotent: true,
    });
    assert.equal(value, "resumed");
    assert.equal(yield* Ref.get(waits), 1);
  }),
);

it.effect("does not retry unrecoverable failures", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const result = yield* Effect.result(
      ProviderRuntimeRecovery.recoverWithPolicy({
        operation: Ref.update(attempts, (count) => count + 1).pipe(
          Effect.andThen(Effect.fail("invalid credentials")),
        ),
        classify: () => ({ kind: "auth_invalid" }),
        connectivity: { isOnline: Effect.succeed(true), awaitOnline: Effect.void },
        maxAttempts: 3,
        idempotent: true,
      }),
    );
    assert.equal(result._tag, "Failure");
    assert.equal(yield* Ref.get(attempts), 1);
  }),
);

it.effect("drains durable effects before reporting recovery complete", () =>
  Effect.gen(function* () {
    const runs = yield* Ref.make(0);
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 2,
                snapshotSequence: 0,
                threads: [],
                archivedThreads: [],
              }),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
          Layer.mock(EventSink.EventSinkV2)({}),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runOnce: Ref.getAndUpdate(runs, (count) => count + 1).pipe(
              Effect.map((count) => count < 2),
            ),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({ reclaimRunning: Effect.succeed(0) }),
        ),
      ),
    );
    const summary = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService.pipe(
      Effect.flatMap((service) => service.recover),
      Effect.provide(layer),
    );
    assert.deepEqual(summary, { resumedSessions: 0, terminalizedRuns: 0, executedEffects: 2 });
  }),
);

it.effect("expires orphaned runtime requests before command readiness", () => {
  const threadId = ThreadId.make("thread_recovery_requests");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const committed = vi.fn(
    (input: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]) => {
      committedInput = input;
      return Effect.succeed({ committed: true } as never);
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
    runs: [],
    nodes: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 0,
              threads: [{ id: threadId }],
              archivedThreads: [],
            } as never),
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ commitCommand: committed }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.succeed(false) }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({ reclaimRunning: Effect.succeed(0) }),
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
