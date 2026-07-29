import { assert, it, vi } from "@effect/vitest";
import {
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { ProviderAdapterV2RuntimeRequestResponseInput } from "./ProviderAdapter.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import {
  ProviderSessionLookupError,
  ProviderSessionManagerV2,
  type ProviderSessionManagerV2Shape,
} from "./ProviderSessionManager.ts";
import {
  layer as runtimeRequestServiceLayer,
  RuntimeRequestResponseExecutionError,
  RuntimeRequestServiceV2,
} from "./RuntimeRequestService.ts";

function projectionWithRuntimeRequest(
  runtimeRequest?: OrchestrationV2RuntimeRequest,
): OrchestrationV2ThreadProjection {
  return {
    runtimeRequests: runtimeRequest === undefined ? [] : [runtimeRequest],
  } as unknown as OrchestrationV2ThreadProjection;
}

function resolvedRuntimeRequest(
  requestId: RuntimeRequestId,
  providerSessionId: ProviderSessionId,
): OrchestrationV2RuntimeRequest {
  return {
    id: requestId,
    nodeId: NodeId.make(`node-${requestId}`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "command",
    status: "resolved",
    responseCapability: {
      type: "live",
      providerSessionId,
    },
    createdAt: DateTime.makeUnsafe("2026-07-29T00:00:00.000Z"),
    resolvedAt: DateTime.makeUnsafe("2026-07-29T00:00:01.000Z"),
  };
}

function runtimeRequestTestLayer(
  projection: OrchestrationV2ThreadProjection,
  getSession: ProviderSessionManagerV2Shape["get"],
) {
  return runtimeRequestServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManagerV2)({
          get: getSession,
        }),
      ),
    ),
  );
}

it.effect("forwards orchestrator-resolved runtime requests to the live adapter", () => {
  const threadId = ThreadId.make("thread-runtime-request-resolved");
  const providerSessionId = ProviderSessionId.make("provider-session-runtime-request-resolved");
  const requestId = RuntimeRequestId.make("request-resolved");
  const respondToRuntimeRequest = vi.fn(
    (_input: ProviderAdapterV2RuntimeRequestResponseInput) => Effect.void,
  );
  const getSession = vi.fn(() =>
    Effect.succeed(
      Option.some({
        respondToRuntimeRequest,
      } as never),
    ),
  );
  const projection = {
    runtimeRequests: [
      {
        id: requestId,
        nodeId: NodeId.make("node-runtime-request-resolved"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "resolved",
        responseCapability: {
          type: "live",
          providerSessionId,
        },
        createdAt: DateTime.makeUnsafe("2026-07-29T00:00:00.000Z"),
        resolvedAt: DateTime.makeUnsafe("2026-07-29T00:00:01.000Z"),
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = runtimeRequestServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManagerV2)({
          get: getSession,
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* RuntimeRequestServiceV2;
    yield* service.respond({
      threadId,
      providerSessionId,
      requestId,
      decision: "accept",
    });

    assert.equal(getSession.mock.calls.length, 1);
    assert.equal(respondToRuntimeRequest.mock.calls.length, 1);
    assert.deepEqual(respondToRuntimeRequest.mock.calls[0]?.[0], {
      requestId,
      decision: "accept",
    });
  }).pipe(Effect.provide(testLayer));
});

it.effect("rejects expired runtime requests before invoking the live adapter", () => {
  const threadId = ThreadId.make("thread-runtime-request-expired");
  const providerSessionId = ProviderSessionId.make("provider-session-runtime-request-expired");
  const requestId = RuntimeRequestId.make("request-expired");
  const respondToRuntimeRequest = vi.fn(
    (_input: ProviderAdapterV2RuntimeRequestResponseInput) => Effect.void,
  );
  const getSession = vi.fn(() =>
    Effect.succeed(
      Option.some({
        respondToRuntimeRequest,
      } as never),
    ),
  );
  const projection = {
    runtimeRequests: [
      {
        id: requestId,
        nodeId: NodeId.make("node-runtime-request-expired"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "expired",
        responseCapability: {
          type: "live",
          providerSessionId,
        },
        createdAt: DateTime.makeUnsafe("2026-07-29T00:00:00.000Z"),
        resolvedAt: DateTime.makeUnsafe("2026-07-29T00:00:01.000Z"),
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = runtimeRequestServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManagerV2)({
          get: getSession,
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* RuntimeRequestServiceV2;
    const error = yield* service
      .respond({
        threadId,
        providerSessionId,
        requestId,
        decision: "accept",
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "request-not-ready");
    assert.equal(
      error.message,
      `Runtime request ${requestId} on thread ${threadId} is not ready for response execution.`,
    );
    assert.isUndefined(error.cause);
    assert.equal(getSession.mock.calls.length, 0);
    assert.equal(respondToRuntimeRequest.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("classifies runtime request response validation failures", () => {
  const threadId = ThreadId.make("thread-runtime-request-validation");
  const providerSessionId = ProviderSessionId.make("provider-session-runtime-request-validation");
  const otherProviderSessionId = ProviderSessionId.make(
    "provider-session-runtime-request-validation-other",
  );
  const requestId = RuntimeRequestId.make("request-validation");
  const unexpectedGetSession = vi.fn(() => Effect.succeed(Option.none()));
  const missingLayer = runtimeRequestTestLayer(
    projectionWithRuntimeRequest(),
    unexpectedGetSession,
  );
  const notResumableLayer = runtimeRequestTestLayer(
    projectionWithRuntimeRequest(resolvedRuntimeRequest(requestId, otherProviderSessionId)),
    unexpectedGetSession,
  );
  const inactiveLayer = runtimeRequestTestLayer(
    projectionWithRuntimeRequest(resolvedRuntimeRequest(requestId, providerSessionId)),
    () => Effect.succeed(Option.none()),
  );
  const respond = Effect.gen(function* () {
    const service = yield* RuntimeRequestServiceV2;
    return yield* service
      .respond({
        threadId,
        providerSessionId,
        requestId,
        decision: "accept",
      })
      .pipe(Effect.flip);
  });

  return Effect.gen(function* () {
    const missing = yield* respond.pipe(Effect.provide(missingLayer));
    assert.equal(missing.reason, "request-missing");
    assert.equal(
      missing.message,
      `Runtime request ${requestId} no longer exists on thread ${threadId}.`,
    );
    assert.isUndefined(missing.cause);

    const notResumable = yield* respond.pipe(Effect.provide(notResumableLayer));
    assert.equal(notResumable.reason, "request-not-resumable");
    assert.equal(
      notResumable.message,
      `Runtime request ${requestId} on thread ${threadId} is not resumable on provider session ${providerSessionId}.`,
    );
    assert.isUndefined(notResumable.cause);

    const inactive = yield* respond.pipe(Effect.provide(inactiveLayer));
    assert.equal(inactive.reason, "provider-session-not-active");
    assert.equal(
      inactive.message,
      `Provider session ${providerSessionId} is not active for runtime request ${requestId} on thread ${threadId}.`,
    );
    assert.isUndefined(inactive.cause);
    assert.equal(unexpectedGetSession.mock.calls.length, 0);
  });
});

it.effect("preserves genuine provider session lookup failures as the cause", () => {
  const threadId = ThreadId.make("thread-runtime-request-lookup-failure");
  const providerSessionId = ProviderSessionId.make(
    "provider-session-runtime-request-lookup-failure",
  );
  const requestId = RuntimeRequestId.make("request-lookup-failure");
  const lookupFailure = new ProviderSessionLookupError({
    providerSessionId,
    cause: "lookup failed",
  });
  const testLayer = runtimeRequestTestLayer(
    projectionWithRuntimeRequest(resolvedRuntimeRequest(requestId, providerSessionId)),
    () => Effect.fail(lookupFailure),
  );

  return Effect.gen(function* () {
    const service = yield* RuntimeRequestServiceV2;
    const error = yield* service
      .respond({
        threadId,
        providerSessionId,
        requestId,
        decision: "accept",
      })
      .pipe(Effect.flip);

    assert.instanceOf(error, RuntimeRequestResponseExecutionError);
    assert.equal(error.reason, "unexpected-failure");
    assert.equal(
      error.message,
      `Failed to respond to runtime request ${requestId} on thread ${threadId} via provider session ${providerSessionId}.`,
    );
    assert.strictEqual(error.cause, lookupFailure);
  }).pipe(Effect.provide(testLayer));
});
