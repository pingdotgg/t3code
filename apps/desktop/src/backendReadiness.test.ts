import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Result } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { BackendReadinessAbortedError, waitForHttpReadyEffect } from "./backendReadiness.ts";

function responseForRequest(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(request, new Response(null, { status }));
}

function httpClientLayer(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

describe("waitForHttpReadyEffect", () => {
  it.effect("returns once the backend serves the requested readiness path", () => {
    const requestUrls: Array<string> = [];
    const statuses = [503, 200];
    const layer = Layer.merge(
      TestClock.layer(),
      httpClientLayer((request) =>
        Effect.sync(() => {
          const status = statuses.shift();
          assert.isDefined(status);
          requestUrls.push(request.url);
          return responseForRequest(request, status);
        }),
      ),
    );

    return Effect.gen(function* () {
      const fiber = yield* waitForHttpReadyEffect(new URL("http://127.0.0.1:3773"), {
        timeout: Duration.seconds(1),
        interval: Duration.millis(100),
      }).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      assert.deepEqual(requestUrls, ["http://127.0.0.1:3773/"]);

      yield* TestClock.adjust(Duration.millis(100));
      yield* Fiber.join(fiber);

      assert.deepEqual(requestUrls, ["http://127.0.0.1:3773/", "http://127.0.0.1:3773/"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("retries after a readiness request stalls past the per-request timeout", () => {
    let calls = 0;
    const layer = Layer.merge(
      TestClock.layer(),
      httpClientLayer((request) => {
        calls += 1;
        return calls === 1 ? Effect.never : Effect.succeed(responseForRequest(request, 200));
      }),
    );

    return Effect.gen(function* () {
      const fiber = yield* waitForHttpReadyEffect(new URL("http://127.0.0.1:3773"), {
        timeout: Duration.seconds(1),
        interval: Duration.millis(100),
        requestTimeout: Duration.millis(250),
      }).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      assert.equal(calls, 1);

      yield* TestClock.adjust(Duration.millis(350));
      yield* Fiber.join(fiber);

      assert.equal(calls, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("times out using the Effect clock when readiness never succeeds", () => {
    const layer = Layer.merge(
      TestClock.layer(),
      httpClientLayer(() => Effect.never),
    );

    return Effect.gen(function* () {
      const fiber = yield* Effect.result(
        waitForHttpReadyEffect(new URL("http://127.0.0.1:3773"), {
          timeout: Duration.seconds(1),
          interval: Duration.millis(100),
          requestTimeout: Duration.millis(250),
        }),
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1_000));
      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(
          result.failure.message,
          "Timed out waiting for backend readiness at http://127.0.0.1:3773/.",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("recognizes aborted readiness errors", () =>
    Effect.sync(() => {
      assert.equal(BackendReadinessAbortedError.is(new BackendReadinessAbortedError()), true);
      assert.equal(BackendReadinessAbortedError.is(new Error("nope")), false);
    }),
  );
});
