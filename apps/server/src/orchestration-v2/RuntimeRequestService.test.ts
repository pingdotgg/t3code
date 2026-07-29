import { assert, it, vi } from "@effect/vitest";
import {
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { ProviderAdapterV2RuntimeRequestResponseInput } from "./ProviderAdapter.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import {
  layer as runtimeRequestServiceLayer,
  RuntimeRequestServiceV2,
} from "./RuntimeRequestService.ts";

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

    assert.equal(error.cause, "The runtime request is not ready for response execution.");
    assert.equal(getSession.mock.calls.length, 0);
    assert.equal(respondToRuntimeRequest.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});
