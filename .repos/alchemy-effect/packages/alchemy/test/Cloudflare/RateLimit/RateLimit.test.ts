import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// The worker calls `rateLimit.limit({ key })` `n` times inside a single
// request and returns the per-call `success` flags. Hitting the binding from
// one isolate makes the throttling deterministic and avoids relying on edge
// propagation between separate HTTP requests.
const burst = Effect.fn(function* (url: string, key: string, n: number) {
  const client = yield* HttpClient.HttpClient;
  const res = yield* client
    .get(`${url}/burst?key=${encodeURIComponent(key)}&n=${n}`)
    .pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
      ),
      Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 15 }),
    );
  return (yield* res.json) as { key: string; results: boolean[] };
});

const freshKey = () => `fresh-${Math.random().toString(36).slice(2)}`;

// Both worker styles bind the same RateLimit shape (`limit: 2`, `period: 10`)
// and expose the identical `/burst` contract, so they share one behavioral
// suite parameterized by which deployed URL to hit.
const behaviorSuite = (label: string, getUrl: () => Effect.Effect<string>) =>
  describe(label, () => {
    test(
      "throttles requests past the configured limit",
      Effect.gen(function* () {
        const url = yield* getUrl();
        expect(url).toBeTypeOf("string");

        // Limit is 2 over a 10s window. Cloudflare's limiter is best-effort
        // (per-colo, approximate counting), so we don't assert an exact
        // allowed count — only the observable contract: the first call is
        // allowed, the burst is eventually throttled, and once the budget is
        // exhausted later calls stay denied.
        const n = 10;
        const { results } = yield* burst(url, freshKey(), n);

        expect(results).toHaveLength(n);
        expect(results[0]).toBe(true);
        expect(results.at(-1)).toBe(false);
        // Some calls were allowed, some denied.
        const allowed = results.filter(Boolean).length;
        expect(allowed).toBeGreaterThan(0);
        expect(allowed).toBeLessThan(n);
      }).pipe(logLevel),
      { timeout: 180_000 },
    );

    test(
      "tracks each key independently",
      Effect.gen(function* () {
        const url = yield* getUrl();

        // A distinct key gets its own fresh budget regardless of how much a
        // previous key was throttled.
        const fresh = yield* burst(url, freshKey(), 1);
        expect(fresh.results).toEqual([true]);
      }).pipe(logLevel),
      { timeout: 180_000 },
    );
  });

behaviorSuite("async worker (env binding)", () =>
  stack.pipe(Effect.map((s) => s.asyncUrl)),
);

behaviorSuite("effect worker (yield* RateLimit)", () =>
  stack.pipe(Effect.map((s) => s.effectUrl)),
);
