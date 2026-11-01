import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  retryManagedTunnelRegistration,
  watchManagedTunnelOrigin,
} from "./managedTunnelStartup.ts";

describe("retryManagedTunnelRegistration", () => {
  it.effect("does not fall back or retry when registration is permanently rejected", () =>
    Effect.gen(function* () {
      let attempts = 0;
      let fallbacks = 0;
      const error = yield* Effect.flip(
        retryManagedTunnelRegistration(
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail("not authorized");
          }),
          () => false,
          Effect.sync(() => {
            fallbacks += 1;
          }),
        ),
      );
      expect(error).toBe("not authorized");
      expect(attempts).toBe(1);
      expect(fallbacks).toBe(0);
    }),
  );
});

describe("watchManagedTunnelOrigin", () => {
  const localOrigin = "http://127.0.0.1:3773";

  /** Runs the watcher for `minutes`, serving each check the next ingress in `ingress`. */
  const watch = (input: {
    readonly ingress: ReadonlyArray<string | null>;
    readonly minutes: number;
    readonly failRegistration?: boolean;
  }) =>
    Effect.gen(function* () {
      let checks = 0;
      const registeredAtMinute: Array<number> = [];
      let minute = 0;
      const fiber = yield* watchManagedTunnelOrigin({
        localOrigin,
        readIngressOrigin: Effect.sync(
          () => input.ingress[Math.min(checks++, input.ingress.length - 1)] ?? null,
        ),
        register: Effect.suspend(() => {
          registeredAtMinute.push(minute);
          return input.failRegistration ? Effect.fail("relay unavailable") : Effect.void;
        }),
      }).pipe(Effect.forkChild);
      for (; minute < input.minutes;) {
        minute += 1;
        yield* TestClock.adjust("1 minute");
      }
      yield* Fiber.interrupt(fiber);
      return { checks, registeredAtMinute };
    });

  it.effect("registers this server again when the ingress names another local port", () =>
    Effect.gen(function* () {
      const result = yield* watch({
        ingress: ["http://127.0.0.1:46169", localOrigin],
        minutes: 5,
      });
      expect(result.registeredAtMinute).toEqual([1]);
    }),
  );

  it.effect("leaves a matching or unknown ingress alone", () =>
    Effect.gen(function* () {
      const result = yield* watch({
        ingress: [null, `${localOrigin}/`, localOrigin],
        minutes: 5,
      });
      expect(result.checks).toBe(5);
      expect(result.registeredAtMinute).toEqual([]);
    }),
  );

  it.effect("keeps checking after a failed registration", () =>
    Effect.gen(function* () {
      const result = yield* watch({
        ingress: ["http://127.0.0.1:46169", "http://127.0.0.1:46169", localOrigin],
        minutes: 8,
        failRegistration: true,
      });
      expect(result.registeredAtMinute).toEqual([1, 3]);
      // Minutes 1, 3, and 7; the match at 7 restores the one-minute interval.
      expect(result.checks).toBe(4);
    }),
  );

  it.effect("backs off while the relay keeps routing elsewhere", () =>
    Effect.gen(function* () {
      const result = yield* watch({ ingress: ["http://127.0.0.1:46169"], minutes: 20 });
      expect(result.registeredAtMinute).toEqual([1, 3, 7, 15]);
    }),
  );

  it.effect("keeps the backoff when one check cannot read the ingress", () =>
    Effect.gen(function* () {
      const result = yield* watch({
        ingress: ["http://127.0.0.1:46169", null, "http://127.0.0.1:46169"],
        minutes: 10,
      });
      expect(result.registeredAtMinute).toEqual([1, 5, 9]);
    }),
  );
});
