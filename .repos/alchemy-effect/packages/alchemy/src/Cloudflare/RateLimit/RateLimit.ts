import type * as Effect from "effect/Effect";
import { SingleShotGen } from "effect/Utils";
import { RateLimitBinding, type RateLimitClient } from "./RateLimitBinding.ts";

type RateLimitTypeId = typeof RateLimitTypeId;
const RateLimitTypeId = "Cloudflare.RateLimit" as const;

export type RateLimitPeriod = 10 | 60;

export type RateLimitProps = {
  /**
   * Binding name used when `RateLimit` is bound from inside a Worker init
   * phase (`yield* Cloudflare.RateLimit(...)`). When passed through
   * `Worker({ env: { ... } })`, the object key remains the binding name.
   *
   * @default "RATE_LIMIT"
   */
  name?: string;
  /**
   * Positive integer or string that uniquely identifies this rate limit
   * configuration.
   */
  namespaceId: number | string;
  /**
   * Simple rate limiting configuration.
   */
  simple: {
    /**
     * The number of requests allowed within the period.
     */
    limit: number;
    /**
     * The period, in seconds, over which requests are counted.
     */
    period: RateLimitPeriod;
  };
};

/**
 * The Effect yielded when a `RateLimit` is used inside a Worker init phase:
 * it attaches the `ratelimit` binding to the surrounding Worker and resolves
 * to the runtime {@link RateLimitClient}.
 */
type BindEffect = Effect.Effect<RateLimitClient, never, RateLimitBinding>;

/**
 * A Cloudflare Rate Limit binding marker.
 *
 * It is a plain data structure (so it can be declared directly on a Worker's
 * `env`) that is **also** yieldable inside an Effect-native Worker. Yielding it
 * (`yield* Cloudflare.RateLimit(...)`) attaches the binding to the surrounding
 * Worker and returns the runtime {@link RateLimitClient} — no separate
 * `.bind(...)` step required.
 *
 * The divergence is achieved via `[Symbol.iterator]`: the object is not an
 * `Effect` (so `InferEnv` resolves it to the native `cf.RateLimit` in the
 * `env` position), but it is iterable as one when `yield*`-ed.
 */
export interface RateLimit {
  kind: RateLimitTypeId;
  name: string;
  namespaceId: string;
  simple: {
    limit: number;
    period: RateLimitPeriod;
  };
  asEffect(): BindEffect;
  [Symbol.iterator](): SingleShotGen<BindEffect, RateLimitClient>;
}

export const isRateLimit = (value: unknown): value is RateLimit =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as RateLimit).kind === RateLimitTypeId;

/**
 * A Cloudflare Rate Limit binding for counting arbitrary keys inside Workers.
 *
 * Rate Limit bindings are configured directly on Workers and do not have a
 * standalone provisioning API. The Worker provider sees this object in
 * `env: { ... }` and emits the corresponding `{ type: "ratelimit" }` metadata
 * binding to the script.
 *
 * @section Declaring on a Worker's env
 * @example Async (non-Effect) Worker
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: {
 *     THROTTLE: Cloudflare.RateLimit({
 *       namespaceId: 1001,
 *       simple: { limit: 10, period: 60 },
 *     }),
 *   },
 * });
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 * //   { THROTTLE: RateLimit } — the native Cloudflare binding
 *
 * // worker.ts
 * export default {
 *   fetch: async (req: Request, env: WorkerEnv) => {
 *     const { success } = await env.THROTTLE.limit({ key: "ip" });
 *     return new Response(success ? "ok" : "rate limited");
 *   },
 * };
 * ```
 *
 * @section Binding inside an Effect-native Worker
 * @example yield* RateLimit does the binding
 * ```typescript
 * Cloudflare.Worker("Worker", { main: "./src/worker.ts" },
 *   Effect.gen(function* () {
 *     // Attaches the binding to this Worker AND returns the runtime client.
 *     const throttle = yield* Cloudflare.RateLimit({
 *       namespaceId: 1001,
 *       simple: { limit: 10, period: 60 },
 *     });
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { success } = yield* throttle.limit({ key: "ip" });
 *         return HttpServerResponse.text(success ? "ok" : "rate limited");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.RateLimitBindingLive)),
 * );
 * ```
 *
 * @see https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
 */
export const RateLimit: {
  (props: RateLimitProps): RateLimit;
  /**
   * Bind an existing `RateLimit` marker to the surrounding Worker, returning
   * the runtime client. Equivalent to `yield* rateLimit` — prefer yielding the
   * marker directly.
   */
  bind: typeof RateLimitBinding.bind;
} = Object.assign(
  (props: RateLimitProps): RateLimit => {
    const self: RateLimit = {
      kind: RateLimitTypeId,
      name: props.name ?? "RATE_LIMIT",
      namespaceId: String(props.namespaceId),
      simple: {
        limit: props.simple.limit,
        period: props.simple.period,
      },
      asEffect: () => RateLimitBinding.bind(self),
      [Symbol.iterator]: () => new SingleShotGen(RateLimitBinding.bind(self)),
    };
    return self;
  },
  {
    bind: (...args: Parameters<typeof RateLimitBinding.bind>) =>
      RateLimitBinding.bind(...args),
  },
);
