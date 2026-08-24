import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Effect-native Worker fixture that exercises the real Cloudflare RateLimit
 * binding via `RateLimitBinding`. Yielding `Cloudflare.RateLimit(...)`
 * during the Init phase attaches the binding to this Worker and returns the
 * runtime client in one step — no separate `.bind(...)` call. `/burst` then
 * calls `throttle.limit({ key })` `n` times against a single isolate.
 *
 * Driving the limit inside one request makes throttling deterministic (no
 * reliance on edge propagation between requests): with `limit: 2` the first
 * two calls for a key succeed and the rest are denied, while a different key
 * gets its own independent budget.
 */
export default class RateLimitEffectWorker extends Cloudflare.Worker<RateLimitEffectWorker>()(
  "RateLimitEffectWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const throttle = yield* Cloudflare.RateLimit("THROTTLE", {
      namespaceId: 11_001,
      simple: { limit: 2, period: 10 },
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (url.pathname === "/burst") {
          const key = url.searchParams.get("key") ?? "default";
          const n = Number(url.searchParams.get("n") ?? "5");

          const results: boolean[] = [];
          for (let i = 0; i < n; i++) {
            const { success } = yield* throttle
              .limit({ key })
              .pipe(Effect.orDie);
            results.push(success);
          }

          return yield* HttpServerResponse.json({ key, results });
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.RateLimitBinding)),
) {}
