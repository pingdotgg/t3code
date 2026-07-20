import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import {
  type ProviderContinuationRequest,
  ProviderContinuationRequests,
  layer as continuationRequestsLayer,
} from "./ProviderContinuationRequests.ts";
import { workerLive } from "./ProviderContinuationService.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread-provider-continuation");
const providerThreadId = ProviderThreadId.make("provider-thread-continuation");
const driver = ProviderDriverKind.make("continuation-test");
const projection = {
  thread: { archivedAt: null },
  messages: [],
} as unknown as OrchestrationV2ThreadProjection;

const request = (
  dispatchIfCurrent?: ProviderContinuationRequest["dispatchIfCurrent"],
  detail: string | null = null,
): ProviderContinuationRequest => ({
  threadId,
  providerThreadId,
  driver,
  detail,
  ...(dispatchIfCurrent === undefined ? {} : { dispatchIfCurrent }),
});

const makeGuard = Effect.fnUntraced(function* (completed?: Deferred.Deferred<void>) {
  const generation = yield* Ref.make(0);
  const permit = yield* Semaphore.make(1);
  const capture = Effect.gen(function* () {
    const captured = yield* Ref.updateAndGet(generation, (value) => value + 1);
    return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      permit
        .withPermit(
          Effect.gen(function* () {
            if ((yield* Ref.get(generation)) !== captured) return Option.none();
            return Option.some(yield* effect);
          }),
        )
        .pipe(
          completed === undefined
            ? (effect) => effect
            : Effect.ensuring(Deferred.succeed(completed, undefined)),
        );
  });
  return {
    capture,
    invalidate: permit.withPermit(Ref.update(generation, (value) => value + 1)),
  };
});

function testLayer(input: {
  readonly dispatched: Queue.Queue<unknown>;
  readonly getThreadProjection: () => Effect.Effect<OrchestrationV2ThreadProjection>;
}) {
  const threads = Layer.mock(ThreadManagementService)({
    getThreadProjection: input.getThreadProjection,
    dispatch: (command) => Queue.offer(input.dispatched, command).pipe(Effect.as({} as never)),
  });
  const worker = workerLive.pipe(
    Layer.provide(Layer.mergeAll(idAllocatorLayer, continuationRequestsLayer, threads)),
  );
  return Layer.merge(continuationRequestsLayer, worker);
}

describe("ProviderContinuationService", () => {
  it.effect("dispatches a current request exactly once", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests;
        yield* requests.offer(request());
        yield* Queue.take(dispatched);
        yield* Effect.yieldNow;
        assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
      }).pipe(
        Effect.provide(
          testLayer({ dispatched, getThreadProjection: () => Effect.succeed(projection) }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect("drops a request invalidated before dispatch", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests;
        const guard = yield* makeGuard();
        const dispatchIfCurrent = yield* guard.capture;
        yield* guard.invalidate;
        yield* requests.offer(request(dispatchIfCurrent));
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
      }).pipe(
        Effect.provide(
          testLayer({ dispatched, getThreadProjection: () => Effect.succeed(projection) }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect("drops a request invalidated while projection is blocked", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      const projectionEntered = yield* Deferred.make<void>();
      const releaseProjection = yield* Deferred.make<void>();
      const guardCompleted = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests;
        const guard = yield* makeGuard(guardCompleted);
        const dispatchIfCurrent = yield* guard.capture;
        yield* requests.offer(request(dispatchIfCurrent));
        yield* Deferred.await(projectionEntered);
        yield* guard.invalidate;
        yield* Deferred.succeed(releaseProjection, undefined);
        yield* Deferred.await(guardCompleted);
        assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
      }).pipe(
        Effect.provide(
          testLayer({
            dispatched,
            getThreadProjection: () =>
              Deferred.succeed(projectionEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseProjection)),
                Effect.as(projection),
              ),
          }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect("does not revive an old request when a later generation is current", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      const firstProjectionEntered = yield* Deferred.make<void>();
      const releaseFirstProjection = yield* Deferred.make<void>();
      let projectionCalls = 0;
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests;
        const guard = yield* makeGuard();
        const first = yield* guard.capture;
        yield* requests.offer(request(first, "A"));
        yield* Deferred.await(firstProjectionEntered);
        const second = yield* guard.capture;
        yield* requests.offer(request(second, "B"));
        yield* Deferred.succeed(releaseFirstProjection, undefined);
        const command = yield* Queue.take(dispatched);
        assert.equal((command as { readonly text?: unknown }).text, "B");
        yield* Effect.yieldNow;
        assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
      }).pipe(
        Effect.provide(
          testLayer({
            dispatched,
            getThreadProjection: () => {
              projectionCalls += 1;
              return projectionCalls === 1
                ? Deferred.succeed(firstProjectionEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseFirstProjection)),
                    Effect.as(projection),
                  )
                : Effect.succeed(projection);
            },
          }),
        ),
        Effect.scoped,
      );
    });
  });
});
