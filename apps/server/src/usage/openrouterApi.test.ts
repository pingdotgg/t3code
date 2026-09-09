import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { makeOpenRouterApi } from "./openrouterApi.ts";

const config = {
  kind: "openrouter",
  managementKey: "sk-or-secret",
  enabled: true,
} as const;

/** Headers arrive, the body never does: the shape that used to hang forever. */
const STALLED_BODY = Symbol("stalled-body");
type Reply = { status: number; body: unknown } | typeof STALLED_BODY;

/** One canned reply per endpoint path, plus the paths actually requested. */
function fixture(replies: Record<string, Reply>) {
  const paths: string[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      expect(request.headers.authorization).toBe("Bearer sk-or-secret");
      const path = new URL(request.url).pathname;
      paths.push(path);
      const reply = replies[path] ?? { status: 404, body: {} };
      if (reply === STALLED_BODY) {
        return HttpClientResponse.fromWeb(
          request,
          new Response(new ReadableStream({ start() {} }), { status: 200 }),
        );
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json(reply.body, { status: reply.status }),
      );
    }),
  );
  return { paths, api: makeOpenRouterApi.pipe(Effect.provideService(HttpClient.HttpClient, http)) };
}

describe("OpenRouter credit reads", () => {
  it.effect("reports the account balance a provisioning key can see", () =>
    Effect.gen(function* () {
      const test = fixture({
        "/api/v1/credits": {
          status: 200,
          body: { data: { total_credits: 100.5, total_usage: 25.75 } },
        },
      });
      const api = yield* test.api;

      expect(yield* api.readCredits(config)).toEqual({
        scope: "account",
        usedUsd: 25.75,
        purchasedUsd: 100.5,
        remainingUsd: 74.75,
      });
      // The narrower read is never made when the account answers.
      expect(test.paths).toEqual(["/api/v1/credits"]);
    }),
  );

  it.effect("falls back to the key's own allowance when OpenRouter refuses with 403", () =>
    Effect.gen(function* () {
      const test = fixture({
        "/api/v1/credits": {
          status: 403,
          body: {
            error: { code: 403, message: "Only management keys can perform this operation" },
          },
        },
        "/api/v1/key": {
          status: 200,
          body: { data: { usage: 1.42, limit: 10, limit_remaining: 8.58, is_free_tier: false } },
        },
      });
      const api = yield* test.api;

      expect(yield* api.readCredits(config)).toEqual({
        scope: "key",
        usedUsd: 1.42,
        limitUsd: 10,
        remainingUsd: 8.58,
        isFreeTier: false,
      });
      expect(test.paths).toEqual(["/api/v1/credits", "/api/v1/key"]);
    }),
  );

  it.effect("leaves an uncapped key with spend only, so no balance is invented", () =>
    Effect.gen(function* () {
      const test = fixture({
        "/api/v1/credits": { status: 403, body: {} },
        "/api/v1/key": {
          status: 200,
          body: { data: { usage: 3.5, limit: null, limit_remaining: null, is_free_tier: true } },
        },
      });
      const api = yield* test.api;

      expect(yield* api.readCredits(config)).toEqual({
        scope: "key",
        usedUsd: 3.5,
        isFreeTier: true,
      });
    }),
  );

  it.effect("reports a rejected key rather than retrying it against the other endpoint", () =>
    Effect.gen(function* () {
      const test = fixture({ "/api/v1/credits": { status: 401, body: {} } });
      const api = yield* test.api;
      const result = yield* api.readCredits(config).pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.detail).toBe("OpenRouter rejected the API key.");
      }
      expect(test.paths).toEqual(["/api/v1/credits"]);
    }),
  );

  it.effect("reports a body it cannot read instead of publishing a partial balance", () =>
    Effect.gen(function* () {
      const test = fixture({
        "/api/v1/credits": { status: 200, body: { data: { total_credits: "lots" } } },
      });
      const api = yield* test.api;
      const result = yield* api.readCredits(config).pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.detail).toBe("OpenRouter returned an unexpected balance.");
      }
    }),
  );

  // The read runs while UsageLimitSources holds its refresh lock, so a body
  // that never completes would starve every later refresh and redemption.
  it.effect("gives up on a response whose body never arrives", () =>
    Effect.gen(function* () {
      const test = fixture({ "/api/v1/credits": STALLED_BODY });
      const api = yield* test.api;
      const fiber = yield* api.readCredits(config).pipe(Effect.result, Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(16));
      const result = yield* Fiber.join(fiber);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.detail).toBe("Could not reach OpenRouter.");
      }
    }),
  );

  it.effect("never calls OpenRouter without a key", () =>
    Effect.gen(function* () {
      const test = fixture({});
      const api = yield* test.api;
      const result = yield* api.readCredits({ ...config, managementKey: "" }).pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      expect(test.paths).toEqual([]);
    }),
  );
});
