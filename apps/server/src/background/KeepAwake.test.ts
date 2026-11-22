import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as KeepAwake from "./KeepAwake.ts";

describe("KeepAwake.holdWhileWanted", () => {
  it.effect("keeps one hold across a gap shorter than the grace and releases after it", () =>
    Effect.gen(function* () {
      const wanted = yield* Queue.unbounded<boolean>();
      const transitions = yield* Queue.unbounded<"held" | "released">();
      const hold = Effect.acquireRelease(Queue.offer(transitions, "held"), () =>
        Queue.offer(transitions, "released"),
      ).pipe(Effect.andThen(Effect.never), Effect.scoped);
      yield* KeepAwake.holdWhileWanted(Stream.fromQueue(wanted), hold, "60 seconds").pipe(
        Effect.forkScoped,
      );

      yield* Queue.offer(wanted, true);
      expect(yield* Queue.take(transitions)).toBe("held");

      yield* Queue.offer(wanted, false);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(wanted, true);
      yield* TestClock.adjust("120 seconds");
      expect(yield* Queue.size(transitions)).toBe(0);

      yield* Queue.offer(wanted, false);
      yield* TestClock.adjust("120 seconds");
      expect(yield* Queue.take(transitions)).toBe("released");
      expect(yield* Queue.size(transitions)).toBe(0);
    }),
  );
});

describe("KeepAwake.makeHold", () => {
  const warningsLogger = (warnings: Array<Logger.Options<unknown>>) =>
    Logger.layer(
      [Logger.make((entry) => (entry.logLevel === "Warn" ? warnings.push(entry) : undefined))],
      { mergeWithExisting: false },
    );

  it.effect(
    "stops for good after logind denies the inhibitor, with one warning and no stack",
    () => {
      const warnings: Array<Logger.Options<unknown>> = [];
      return Effect.gen(function* () {
        const attempts = yield* Queue.unbounded<number>();
        const hold = yield* KeepAwake.makeHold(
          Queue.offer(attempts, 1).pipe(
            Effect.andThen(
              new KeepAwake.KeepAwakeInhibitorExited({
                exitCode: 1,
                stderr: "Failed to inhibit: Access denied (interactive authentication required)",
              }),
            ),
          ),
        );

        yield* hold;
        yield* TestClock.adjust("1 hour");
        yield* hold;

        expect(yield* Queue.size(attempts)).toBe(1);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.cause.reasons).toHaveLength(0);
      }).pipe(Effect.provide(warningsLogger(warnings)));
    },
  );

  it.effect("retries any other inhibitor exit under backoff", () =>
    Effect.gen(function* () {
      const attempts = yield* Queue.unbounded<number>();
      const hold = yield* KeepAwake.makeHold(
        Queue.offer(attempts, 1).pipe(
          Effect.andThen(new KeepAwake.KeepAwakeInhibitorExited({ exitCode: 1, stderr: "" })),
        ),
      );
      yield* hold.pipe(Effect.forkScoped);

      yield* Queue.take(attempts);
      yield* TestClock.adjust("5 seconds");
      yield* Queue.take(attempts);
      yield* TestClock.adjust("10 seconds");
      yield* Queue.take(attempts);
      expect(yield* Queue.size(attempts)).toBe(0);
    }),
  );
});
