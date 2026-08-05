import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as TestClock from "effect/testing/TestClock";

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
const parentRunId = RunId.make("run-provider-continuation-parent");
const delegatedMessageId = MessageId.make("message-provider-continuation-delegated");
const projection = {
  thread: { archivedAt: null, deletedAt: null },
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

const delegatedProjection = (disposition: "open" | "stopped" | "disposed" = "open") =>
  ({
    ...projection,
    runs: [
      {
        id: parentRunId,
        delegatedCompletion: {
          disposition,
          nextGeneration: 2,
          delivery: {
            generation: 1,
            messageId: delegatedMessageId,
            taskIds: ["node-provider-continuation-first", "node-provider-continuation-second"],
          },
        },
      },
    ],
  }) as unknown as OrchestrationV2ThreadProjection;

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
  it.effect("marks an adapter-buffered wake with the provider creation source", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests;
        yield* requests.offer(request());
        const command = (yield* Queue.take(dispatched)) as { readonly creationSource: string };
        // ClaudeAdapterV2 keys on this to attach buffered CLI output.
        assert.equal(command.creationSource, "provider");
      }).pipe(
        Effect.provide(
          testLayer({ dispatched, getThreadProjection: () => Effect.succeed(projection) }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect("delivers a message_text wake as a real prompt, not a buffered wake", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests;
        yield* requests.offer({
          threadId,
          providerThreadId,
          driver,
          detail: "Delegated task completed.",
          delivery: "message_text",
        });
        const command = (yield* Queue.take(dispatched)) as {
          readonly creationSource: string;
          readonly text: string;
        };
        // An app-owned child buffers nothing in the adapter, so this text is
        // the whole wake. Marking it "provider" would make ClaudeAdapterV2
        // drop it and settle the turn having prompted nothing.
        assert.notEqual(command.creationSource, "provider");
        assert.equal(command.creationSource, "server");
        assert.equal(command.text, "Delegated task completed.");
      }).pipe(
        Effect.provide(
          testLayer({ dispatched, getThreadProjection: () => Effect.succeed(projection) }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect("dispatches a current delegated completion as one server-owned queued message", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests;
        yield* requests.offer({
          threadId,
          providerThreadId,
          driver,
          detail: null,
          delivery: "message_text",
          delegatedCompletion: {
            parentRunId,
            generation: 1,
            messageId: delegatedMessageId,
          },
        });
        const command = (yield* Queue.take(dispatched)) as {
          readonly createdBy: string;
          readonly creationSource: string;
          readonly delegatedCompletion: {
            readonly generation: number;
            readonly parentRunId: RunId;
            readonly taskIds: ReadonlyArray<string>;
          };
          readonly dispatchMode: { readonly type: string };
          readonly messageId: MessageId;
          readonly text: string;
        };
        assert.equal(command.createdBy, "agent");
        assert.equal(command.creationSource, "server");
        assert.deepEqual(command.dispatchMode, { type: "queue_after_active" });
        assert.equal(command.messageId, delegatedMessageId);
        assert.equal(command.delegatedCompletion.parentRunId, parentRunId);
        assert.equal(command.delegatedCompletion.generation, 1);
        assert.deepEqual(command.delegatedCompletion.taskIds, [
          "node-provider-continuation-first",
          "node-provider-continuation-second",
        ]);
        assert.include(command.text, "task_status");
      }).pipe(
        Effect.provide(
          testLayer({
            dispatched,
            getThreadProjection: () => Effect.succeed(delegatedProjection()),
          }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect("retries a delegated completion after a transient dispatch failure", () => {
    return Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const dispatched = yield* Queue.unbounded<unknown>();
      const threads = Layer.mock(ThreadManagementService)({
        getThreadProjection: () => Effect.succeed(delegatedProjection()),
        dispatch: (command) =>
          Ref.getAndUpdate(attempts, (count) => count + 1).pipe(
            Effect.flatMap((attempt) =>
              attempt === 0
                ? Effect.fail(new Error("simulated transient dispatch failure") as never)
                : Queue.offer(dispatched, command).pipe(Effect.as({} as never)),
            ),
          ),
      });
      const worker = workerLive.pipe(
        Layer.provide(Layer.mergeAll(idAllocatorLayer, continuationRequestsLayer, threads)),
      );

      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests;
        yield* requests.offer({
          threadId,
          providerThreadId,
          driver,
          detail: null,
          delivery: "message_text",
          delegatedCompletion: {
            parentRunId,
            generation: 1,
            messageId: delegatedMessageId,
          },
        });
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(attempts), 1);
        assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));

        yield* TestClock.adjust("100 millis");
        const command = (yield* Queue.take(dispatched)) as {
          readonly messageId: MessageId;
        };
        assert.equal(command.messageId, delegatedMessageId);
        assert.equal(yield* Ref.get(attempts), 2);
      }).pipe(Effect.provide(Layer.merge(continuationRequestsLayer, worker)), Effect.scoped);
    });
  });

  it.effect("backs off repeated delegated completion dispatch failures", () => {
    return Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const disposition = yield* Ref.make<"open" | "disposed">("open");
      const threads = Layer.mock(ThreadManagementService)({
        getThreadProjection: () =>
          Ref.get(disposition).pipe(Effect.map((state) => delegatedProjection(state))),
        dispatch: () =>
          Ref.update(attempts, (count) => count + 1).pipe(
            Effect.andThen(Effect.fail(new Error("simulated persistent failure") as never)),
          ),
      });
      const worker = workerLive.pipe(
        Layer.provide(Layer.mergeAll(idAllocatorLayer, continuationRequestsLayer, threads)),
      );

      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests;
        yield* requests.offer({
          threadId,
          providerThreadId,
          driver,
          detail: null,
          delivery: "message_text",
          delegatedCompletion: {
            parentRunId,
            generation: 1,
            messageId: delegatedMessageId,
          },
        });
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(attempts), 1);

        yield* TestClock.adjust("100 millis");
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(attempts), 2);
        yield* TestClock.adjust("199 millis");
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(attempts), 2);
        yield* TestClock.adjust("1 millis");
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(attempts), 3);

        yield* Ref.set(disposition, "disposed");
        yield* TestClock.adjust("400 millis");
      }).pipe(Effect.provide(Layer.merge(continuationRequestsLayer, worker)), Effect.scoped);
    });
  });

  it.effect("resets delegated completion retry backoff after archive or deletion", () => {
    return Effect.gen(function* () {
      for (const barrier of ["archivedAt", "deletedAt"] as const) {
        const attempts = yield* Ref.make(0);
        const blockedProjectionReads = yield* Ref.make(0);
        const blockedRequestDropped = yield* Deferred.make<void>();
        const state = yield* Ref.make<"open" | "blocked" | "disposed">("open");
        const threads = Layer.mock(ThreadManagementService)({
          getThreadProjection: () =>
            Effect.gen(function* () {
              const currentState = yield* Ref.get(state);
              if (currentState === "blocked") {
                const reads = yield* Ref.updateAndGet(blockedProjectionReads, (count) => count + 1);
                if (reads === 2) {
                  yield* Deferred.succeed(blockedRequestDropped, undefined);
                }
              }
              return {
                ...delegatedProjection(currentState === "disposed" ? "disposed" : "open"),
                thread: {
                  ...projection.thread,
                  [barrier]:
                    currentState === "blocked"
                      ? DateTime.makeUnsafe("2026-08-05T00:00:00.000Z")
                      : null,
                },
              };
            }),
          dispatch: () =>
            Ref.update(attempts, (count) => count + 1).pipe(
              Effect.andThen(Effect.fail(new Error("simulated persistent failure") as never)),
            ),
        });
        const worker = workerLive.pipe(
          Layer.provide(Layer.mergeAll(idAllocatorLayer, continuationRequestsLayer, threads)),
        );
        const completionRequest = {
          threadId,
          providerThreadId,
          driver,
          detail: null,
          delivery: "message_text" as const,
          delegatedCompletion: {
            parentRunId,
            generation: 1,
            messageId: delegatedMessageId,
          },
        };

        yield* Effect.gen(function* () {
          const requests = yield* ProviderContinuationRequests;
          yield* requests.offer(completionRequest);
          yield* Effect.yieldNow;
          assert.equal(yield* Ref.get(attempts), 1);

          yield* Ref.set(state, "blocked");
          yield* TestClock.adjust("100 millis");
          yield* Deferred.await(blockedRequestDropped);
          yield* Effect.yieldNow;
          assert.equal(yield* Ref.get(attempts), 1);

          yield* Ref.set(state, "open");
          yield* requests.offer(completionRequest);
          yield* Effect.yieldNow;
          assert.equal(yield* Ref.get(attempts), 2);
          yield* TestClock.adjust("99 millis");
          yield* Effect.yieldNow;
          assert.equal(yield* Ref.get(attempts), 2);
          yield* TestClock.adjust("1 millis");
          yield* Effect.yieldNow;
          assert.equal(yield* Ref.get(attempts), 3);

          yield* Ref.set(state, "disposed");
          yield* TestClock.adjust("200 millis");
        }).pipe(Effect.provide(Layer.merge(continuationRequestsLayer, worker)), Effect.scoped);
      }
    });
  });

  it.effect("drops a delegated completion retry after its delivery closes", () => {
    return Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const disposition = yield* Ref.make<"open" | "disposed">("open");
      const threads = Layer.mock(ThreadManagementService)({
        getThreadProjection: () =>
          Ref.get(disposition).pipe(Effect.map((state) => delegatedProjection(state))),
        dispatch: () =>
          Ref.update(attempts, (count) => count + 1).pipe(
            Effect.andThen(Effect.fail(new Error("simulated dispatch failure") as never)),
          ),
      });
      const worker = workerLive.pipe(
        Layer.provide(Layer.mergeAll(idAllocatorLayer, continuationRequestsLayer, threads)),
      );

      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests;
        yield* requests.offer({
          threadId,
          providerThreadId,
          driver,
          detail: null,
          delivery: "message_text",
          delegatedCompletion: {
            parentRunId,
            generation: 1,
            messageId: delegatedMessageId,
          },
        });
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(attempts), 1);

        yield* Ref.set(disposition, "disposed");
        yield* TestClock.adjust("100 millis");
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(attempts), 1);
      }).pipe(Effect.provide(Layer.merge(continuationRequestsLayer, worker)), Effect.scoped);
    });
  });

  it.effect("keeps a Grok delegated completion queued instead of restarting active work", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests;
        yield* requests.offer({
          threadId,
          providerThreadId,
          driver: ProviderDriverKind.make("grok"),
          detail: null,
          delivery: "message_text",
          delegatedCompletion: {
            parentRunId,
            generation: 1,
            messageId: delegatedMessageId,
          },
        });
        const command = (yield* Queue.take(dispatched)) as {
          readonly dispatchMode: { readonly type: string };
        };
        assert.deepEqual(command.dispatchMode, { type: "queue_after_active" });
      }).pipe(
        Effect.provide(
          testLayer({
            dispatched,
            getThreadProjection: () => Effect.succeed(delegatedProjection()),
          }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect(
    "drops stopped and disposed delegated completions instead of reviving them after recovery",
    () => {
      return Effect.gen(function* () {
        for (const disposition of ["stopped", "disposed"] as const) {
          const dispatched = yield* Queue.unbounded<unknown>();
          yield* Effect.gen(function* () {
            const requests = yield* ProviderContinuationRequests;
            yield* requests.offer({
              threadId,
              providerThreadId,
              driver,
              detail: null,
              delivery: "message_text",
              delegatedCompletion: {
                parentRunId,
                generation: 1,
                messageId: delegatedMessageId,
              },
            });
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
          }).pipe(
            Effect.provide(
              testLayer({
                dispatched,
                getThreadProjection: () => Effect.succeed(delegatedProjection(disposition)),
              }),
            ),
            Effect.scoped,
          );
        }
      });
    },
  );

  it.effect("does not redispatch a persisted delegated completion message during recovery", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests;
        yield* requests.offer({
          threadId,
          providerThreadId,
          driver,
          detail: null,
          delivery: "message_text",
          delegatedCompletion: {
            parentRunId,
            generation: 1,
            messageId: delegatedMessageId,
          },
        });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
      }).pipe(
        Effect.provide(
          testLayer({
            dispatched,
            getThreadProjection: () =>
              Effect.succeed({
                ...delegatedProjection(),
                messages: [{ id: delegatedMessageId }],
              } as unknown as OrchestrationV2ThreadProjection),
          }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect("drops archived and deleted delegated completions during recovery", () => {
    return Effect.gen(function* () {
      for (const barrier of ["archivedAt", "deletedAt"] as const) {
        const dispatched = yield* Queue.unbounded<unknown>();
        yield* Effect.gen(function* () {
          const requests = yield* ProviderContinuationRequests;
          yield* requests.offer({
            threadId,
            providerThreadId,
            driver,
            detail: null,
            delivery: "message_text",
            delegatedCompletion: {
              parentRunId,
              generation: 1,
              messageId: delegatedMessageId,
            },
          });
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
        }).pipe(
          Effect.provide(
            testLayer({
              dispatched,
              getThreadProjection: () =>
                Effect.succeed({
                  ...delegatedProjection(),
                  thread: {
                    ...projection.thread,
                    [barrier]: DateTime.makeUnsafe("2026-08-03T00:00:00.000Z"),
                  },
                } as unknown as OrchestrationV2ThreadProjection),
            }),
          ),
          Effect.scoped,
        );
      }
    });
  });

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

  it.effect("clears a sticky continuation offer when its thread is archived", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      const cleared = yield* Ref.make(false);
      yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests;
        yield* requests.offer({
          ...request(),
          clearIfCurrent: () => Ref.set(cleared, true),
        });
        for (let attempt = 0; attempt < 20 && !(yield* Ref.get(cleared)); attempt += 1) {
          yield* Effect.yieldNow;
        }
        assert.isTrue(yield* Ref.get(cleared));
        assert.isTrue(Option.isNone(yield* Queue.poll(dispatched)));
      }).pipe(
        Effect.provide(
          testLayer({
            dispatched,
            getThreadProjection: () =>
              Effect.succeed({
                ...projection,
                thread: {
                  ...projection.thread,
                  archivedAt: DateTime.makeUnsafe("2026-07-20T00:00:00.000Z"),
                },
              }),
          }),
        ),
        Effect.scoped,
      );
    });
  });
});
