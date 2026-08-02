import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import {
  ProviderInteractionModeReflections,
  layer as reflectionsLayer,
} from "./ProviderInteractionModeReflections.ts";
import { OrchestratorDispatchError, OrchestratorProjectionError } from "./Orchestrator.ts";
import { workerLive } from "./ProviderInteractionModeReflectionService.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread-interaction-mode-reflection");
const driver = ProviderDriverKind.make("reflection-test");

function reflectionCommandId(threadId: ThreadId, dedupeKey: string): string {
  return `interaction-mode-reflection:${threadId}:${dedupeKey}`;
}

function projectionWith(input: {
  readonly archivedAt?: string | null;
  readonly interactionMode: "default" | "plan";
}): OrchestrationV2ThreadProjection {
  return {
    thread: {
      archivedAt: input.archivedAt ?? null,
      interactionMode: input.interactionMode,
    },
  } as unknown as OrchestrationV2ThreadProjection;
}

/**
 * The worker drains sequentially, so a probe request whose dispatch is awaited
 * proves every earlier request finished without dispatching.
 */
function testLayer(input: {
  readonly dispatched: Queue.Queue<unknown>;
  readonly projections: Array<OrchestrationV2ThreadProjection>;
  readonly readProjection?: () => Effect.Effect<
    OrchestrationV2ThreadProjection,
    OrchestratorProjectionError
  >;
  readonly dispatch?: ThreadManagementService["Service"]["dispatch"];
}) {
  const threads = Layer.mock(ThreadManagementService)({
    getThreadProjection: () =>
      input.readProjection?.() ??
      Effect.sync(() => {
        const next = input.projections.shift();
        if (next === undefined) throw new Error("unexpected extra projection read");
        return next;
      }),
    dispatch: (command) =>
      input.dispatch?.(command) ??
      Queue.offer(input.dispatched, command).pipe(Effect.as({} as never)),
  });
  const worker = workerLive.pipe(Layer.provide(Layer.merge(reflectionsLayer, threads)));
  return Layer.merge(reflectionsLayer, worker);
}

const probeReflection = {
  threadId,
  driver,
  interactionMode: "default",
  dedupeKey: "opencode2:probe",
} as const;

describe("ProviderInteractionModeReflectionService", () => {
  it.effect("applies a native plan exit as thread.interaction-mode.set", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      yield* Effect.gen(function* () {
        const requests = yield* ProviderInteractionModeReflections;
        yield* requests.offer({
          threadId,
          driver,
          interactionMode: "default",
          dedupeKey: "opencode2:evt_1",
        });
        const command = (yield* Queue.take(dispatched)) as {
          readonly type: string;
          readonly commandId: string;
          readonly threadId: string;
          readonly interactionMode: string;
        };
        assert.equal(command.type, "thread.interaction-mode.set");
        assert.equal(command.threadId, threadId);
        assert.equal(command.interactionMode, "default");
        // Replayed native events must dedupe through command receipts.
        assert.equal(command.commandId, reflectionCommandId(threadId, "opencode2:evt_1"));
      }).pipe(
        Effect.provide(
          testLayer({
            dispatched,
            projections: [projectionWith({ interactionMode: "plan" })],
          }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect("retries a transient dispatch failure before completing the reflection", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      const firstDispatch = Deferred.makeUnsafe<void>();
      let dispatchAttempts = 0;
      yield* Effect.gen(function* () {
        const requests = yield* ProviderInteractionModeReflections;
        yield* requests.offer({
          threadId,
          driver,
          interactionMode: "default",
          dedupeKey: "opencode2:retry-projection",
        });
        const clockDriver = yield* Effect.gen(function* () {
          yield* Deferred.await(firstDispatch);
          for (let attempt = 0; attempt < 3; attempt += 1) {
            yield* Effect.yieldNow;
            yield* TestClock.adjust("100 millis");
          }
        }).pipe(Effect.forkChild);
        const command = (yield* Queue.take(dispatched)) as {
          readonly commandId: string;
          readonly interactionMode: string;
        };
        assert.equal(
          command.commandId,
          reflectionCommandId(threadId, "opencode2:retry-projection"),
        );
        assert.equal(command.interactionMode, "default");
        assert.equal(dispatchAttempts, 2);
        yield* Fiber.join(clockDriver);
      }).pipe(
        Effect.provide(
          testLayer({
            dispatched,
            projections: [],
            readProjection: () => Effect.succeed(projectionWith({ interactionMode: "plan" })),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchAttempts += 1;
                if (dispatchAttempts === 1) {
                  Deferred.doneUnsafe(firstDispatch, Effect.void);
                }
                return dispatchAttempts;
              }).pipe(
                Effect.flatMap((attempt) =>
                  attempt === 1
                    ? Effect.fail(
                        new OrchestratorDispatchError({
                          commandId: command.commandId,
                          commandType: command.type,
                          cause: new Error("temporary dispatch failure"),
                        }),
                      )
                    : Queue.offer(dispatched, command).pipe(Effect.as({} as never)),
                ),
              ),
          }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect("continues draining after a defective reflection", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      let projectionReads = 0;
      yield* Effect.gen(function* () {
        const requests = yield* ProviderInteractionModeReflections;
        yield* requests.offer({
          threadId,
          driver,
          interactionMode: "default",
          dedupeKey: "opencode2:defective",
        });
        yield* requests.offer(probeReflection);

        const command = (yield* Queue.take(dispatched)) as { readonly commandId: string };
        assert.equal(command.commandId, reflectionCommandId(threadId, "opencode2:probe"));
        assert.equal(projectionReads, 2);
      }).pipe(
        Effect.provide(
          testLayer({
            dispatched,
            projections: [],
            readProjection: () =>
              Effect.sync(() => {
                projectionReads += 1;
                if (projectionReads === 1) throw new Error("unexpected projection defect");
                return projectionWith({ interactionMode: "plan" });
              }),
          }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect("dispatches matching provider event keys independently per thread", () => {
    return Effect.gen(function* () {
      const secondThreadId = ThreadId.make("thread-interaction-mode-reflection-second");
      const dispatched = yield* Queue.unbounded<unknown>();
      yield* Effect.gen(function* () {
        const requests = yield* ProviderInteractionModeReflections;
        const dedupeKey = "opencode2:shared-event";
        yield* requests.offer({
          threadId,
          driver,
          interactionMode: "default",
          dedupeKey,
        });
        yield* requests.offer({
          threadId: secondThreadId,
          driver,
          interactionMode: "default",
          dedupeKey,
        });

        const first = (yield* Queue.take(dispatched)) as { readonly commandId: string };
        const second = (yield* Queue.take(dispatched)) as { readonly commandId: string };
        assert.deepEqual(
          [first.commandId, second.commandId],
          [
            reflectionCommandId(threadId, dedupeKey),
            reflectionCommandId(secondThreadId, dedupeKey),
          ],
        );
      }).pipe(
        Effect.provide(
          testLayer({
            dispatched,
            projections: [
              projectionWith({ interactionMode: "plan" }),
              projectionWith({ interactionMode: "plan" }),
            ],
          }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect("skips a thread already in the reflected mode", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      yield* Effect.gen(function* () {
        const requests = yield* ProviderInteractionModeReflections;
        yield* requests.offer({
          threadId,
          driver,
          interactionMode: "plan",
          dedupeKey: "opencode2:evt_2",
        });
        yield* requests.offer(probeReflection);
        const command = (yield* Queue.take(dispatched)) as { readonly commandId: string };
        assert.equal(command.commandId, reflectionCommandId(threadId, "opencode2:probe"));
        assert.equal(yield* Queue.size(dispatched), 0);
      }).pipe(
        Effect.provide(
          testLayer({
            dispatched,
            projections: [
              projectionWith({ interactionMode: "plan" }),
              projectionWith({ interactionMode: "plan" }),
            ],
          }),
        ),
        Effect.scoped,
      );
    });
  });

  it.effect("skips archived threads", () => {
    return Effect.gen(function* () {
      const dispatched = yield* Queue.unbounded<unknown>();
      yield* Effect.gen(function* () {
        const requests = yield* ProviderInteractionModeReflections;
        yield* requests.offer({
          threadId,
          driver,
          interactionMode: "default",
          dedupeKey: "opencode2:evt_3",
        });
        yield* requests.offer(probeReflection);
        const command = (yield* Queue.take(dispatched)) as { readonly commandId: string };
        assert.equal(command.commandId, reflectionCommandId(threadId, "opencode2:probe"));
        assert.equal(yield* Queue.size(dispatched), 0);
      }).pipe(
        Effect.provide(
          testLayer({
            dispatched,
            projections: [
              projectionWith({
                archivedAt: "2026-07-31T00:00:00.000Z",
                interactionMode: "plan",
              }),
              projectionWith({ interactionMode: "plan" }),
            ],
          }),
        ),
        Effect.scoped,
      );
    });
  });
});
