import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect } from "vite-plus/test";

import { waitForHttpReady } from "./httpReadiness.ts";

const options = {
  baseUrl: "http://localhost:3773/",
  timeoutMs: 1_000,
  probeTimeoutMs: 250,
  intervalMs: 100,
  makeError: ({ cause }: { readonly cause: unknown }) => new Error("Readiness failed", { cause }),
};

describe("waitForHttpReady", () => {
  it.effect.each(["headers", "body"] as const)(
    "retries after stalled %s and interrupts the stalled probe",
    (phase) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const stalled = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        );
        let attempts = 0;
        const signals: AbortSignal[] = [];
        const client = HttpClient.make((request, _url, signal) =>
          Effect.suspend(() => {
            attempts += 1;
            signals.push(signal);
            const response = HttpClientResponse.fromWeb(request, new Response("ready"));
            if (attempts !== 1) return Effect.succeed(response);
            if (phase === "headers") return stalled;
            Object.defineProperty(response, "text", { value: stalled });
            return Effect.succeed(response);
          }),
        );
        const fiber = yield* waitForHttpReady(options).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.result,
          Effect.forkChild,
        );

        yield* Deferred.await(started);
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(fiber);

        expect(Result.isSuccess(result)).toBe(true);
        expect(attempts).toBe(2);
        expect(yield* Deferred.isDone(interrupted)).toBe(true);
        expect(signals[0]?.aborted).toBe(true);
        expect(signals[1]?.aborted).toBe(false);
      }),
  );

  it.effect("reports the last body timeout when no probe completes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let attempts = 0;
      const failures: unknown[] = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          attempts += 1;
          const response = HttpClientResponse.fromWeb(request, new Response(""));
          Object.defineProperty(response, "text", {
            value: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          });
          return response;
        }),
      );
      const fiber = yield* waitForHttpReady({
        ...options,
        makeError: (info) => {
          failures.push(info.cause);
          return options.makeError(info);
        },
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(fiber);

      expect(attempts).toBe(3);
      expect(failures.slice(0, 3)).toEqual(
        [1, 2, 3].map((attempt) => ({ kind: "probe-timeout", attempt, probeTimeoutMs: 250 })),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.cause).toMatchObject({
          kind: "overall-timeout",
          lastFailure: {
            attempt: 3,
          },
        });
      }
    }),
  );
});
