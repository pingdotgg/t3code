import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Logger } from "effect";

import { currentLogContext, withLogContext } from "./LogContext.ts";

const captureAnnotations = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const captured: Array<Record<string, unknown>> = [];
    const capturingLogger = Logger.map(Logger.formatStructured, (entry) => {
      captured.push(entry.annotations);
      return entry;
    });

    yield* effect.pipe(
      Effect.provide(Logger.layer([capturingLogger], { mergeWithExisting: false })),
    );
    return captured;
  });

describe("LogContext", () => {
  it.effect("defaults to an empty context", () =>
    Effect.gen(function* () {
      const context = yield* currentLogContext;
      assert.deepStrictEqual(context, {});
    }),
  );

  it.effect("tags every log line within the boundary with the merged context", () =>
    Effect.gen(function* () {
      const captured = yield* captureAnnotations(
        Effect.gen(function* () {
          yield* Effect.logInfo("before boundary");
          yield* Effect.logInfo("inside boundary").pipe(
            withLogContext({ threadId: "thread-1", provider: "codex" }),
          );
          yield* Effect.logInfo("after boundary");
        }),
      );

      assert.deepStrictEqual(captured[0], {});
      assert.deepStrictEqual(captured[1], { threadId: "thread-1", provider: "codex" });
      assert.deepStrictEqual(captured[2], {});
    }),
  );

  it.effect("merges nested boundaries instead of clobbering outer fields", () =>
    Effect.gen(function* () {
      const captured = yield* captureAnnotations(
        Effect.logInfo("nested").pipe(
          withLogContext({ sessionId: "session-1" }),
          withLogContext({ threadId: "thread-1", provider: "codex" }),
        ),
      );

      assert.deepStrictEqual(captured[0], {
        threadId: "thread-1",
        provider: "codex",
        sessionId: "session-1",
      });
    }),
  );

  it.effect("propagates to fibers forked from within the boundary", () =>
    Effect.gen(function* () {
      const captured = yield* captureAnnotations(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(Effect.logInfo("forked"));
          yield* Fiber.join(fiber);
        }).pipe(withLogContext({ threadId: "thread-1", provider: "codex" })),
      );

      assert.deepStrictEqual(captured[0], { threadId: "thread-1", provider: "codex" });
    }),
  );
});
