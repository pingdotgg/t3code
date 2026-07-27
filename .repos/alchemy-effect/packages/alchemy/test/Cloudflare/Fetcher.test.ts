import { fromCloudflareFetcher } from "@/Cloudflare/Fetcher";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

// A Cloudflare fetcher whose first `failures` `.fetch()` calls reject with the
// given message, then resolve with a 200 — models a Durable Object / service
// binding that is briefly mid-propagation after deploy (workerd routes to a
// stale script version that has no fetch handler yet).
//
// The retry lives in `fromCloudflareFetcher` — the single adapter every CF
// binding flows through — NOT in any one higher-level wrapper (`toHttpClient`,
// the RPC DO transport, etc.), because the "no fetch handler" window is a
// property of invoking the binding itself, so every consumer should be
// resilient to it without re-implementing the retry.
const flakyFetcher = (failures: number, message: string) => {
  let attempts = 0;
  return {
    attempts: () => attempts,
    fetch: (_request: any, _opts?: any) => {
      attempts++;
      return attempts <= failures
        ? Promise.reject(new Error(message))
        : Promise.resolve(new Response(null, { status: 200 }));
    },
    connect: () => {
      throw new Error("connect not supported in test");
    },
  };
};

describe("fromCloudflareFetcher", () => {
  // `it.live` uses the real clock so the retry's backoff delays actually
  // elapse (the default `it.effect` TestClock would never advance them).
  it.live(
    "retries the just-deployed 'no fetch handler' propagation window",
    () =>
      Effect.gen(function* () {
        const fetcher = flakyFetcher(
          2,
          "Handler does not export a fetch() function.",
        );
        const client = fromCloudflareFetcher(fetcher as any);

        const res = yield* client.fetch(HttpClientRequest.get("http://do/"));

        expect(res.status).toBe(200);
        // Two not-ready failures + one success.
        expect(fetcher.attempts()).toBe(3);
      }),
  );

  it.live("does not retry unrelated failures", () =>
    Effect.gen(function* () {
      const fetcher = flakyFetcher(99, "some other boom");
      const client = fromCloudflareFetcher(fetcher as any);

      const outcome = yield* client
        .fetch(HttpClientRequest.get("http://do/"))
        .pipe(Effect.exit);

      expect(outcome._tag).toBe("Failure");
      // A non-propagation error is surfaced on the first attempt — no retry.
      expect(fetcher.attempts()).toBe(1);
    }),
  );
});
