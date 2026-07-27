import type * as cf from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import * as Binding from "./Binding.ts";
import type { RateLimitBinding } from "./RateLimitBinding.ts";

const TypeId = "Cloudflare.RateLimit" as const;
type TypeId = typeof TypeId;

export type RateLimitPeriod = 10 | 60;

export class RateLimitError extends Data.TaggedError("RateLimitError")<{
  message: string;
  cause: unknown;
}> {}

/**
 * Effect-native client for a Cloudflare Rate Limit binding. Wraps the runtime
 * `cf.RateLimit` so `limit` returns an `Effect` tagged with {@link RateLimitError}.
 */
export interface RateLimitClient {
  /** Effect resolving to the raw Cloudflare runtime binding. */
  raw: Effect.Effect<cf.RateLimit, never, RuntimeContext>;
  limit(
    options: Parameters<cf.RateLimit["limit"]>[0],
  ): Effect.Effect<
    Awaited<ReturnType<cf.RateLimit["limit"]>>,
    RateLimitError,
    RuntimeContext
  >;
}

export type RateLimitProps = {
  /**
   * Positive integer or string that uniquely identifies this rate limit
   * configuration.
   */
  namespaceId: number | string;
  /** Simple rate limiting configuration. */
  simple: {
    /** The number of requests allowed within the period. */
    limit: number;
    /** The period, in seconds, over which requests are counted. */
    period: RateLimitPeriod;
  };
};

/**
 * A Cloudflare Rate Limit binding for counting arbitrary keys inside Workers — a
 * Worker-only binding with no backing cloud resource.
 *
 * `RateLimit` is a single value that is at once the `Binding.Service` tag, the
 * callable that produces a {@link RateLimitBinding}, and the type. Declare it on
 * a Worker's `env` (it flows through `InferEnv` → the native `cf.RateLimit`) or
 * `yield*` it inside an Effect-native Worker to attach the binding and obtain
 * the {@link RateLimitClient}.
 *
 * @binding
 * @product Rate Limiting
 * @category Application Security
 * @section Declaring on a Worker's env
 * @example Async (non-Effect) Worker
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: {
 *     THROTTLE: Cloudflare.RateLimit("THROTTLE", {
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
 *     const throttle = yield* Cloudflare.RateLimit("THROTTLE", {
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
 *   }).pipe(Effect.provide(Cloudflare.Workers.RateLimitBinding)),
 * );
 * ```
 *
 * @see https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
 */
export interface RateLimit extends Binding.Service<
  RateLimit,
  TypeId,
  RateLimitClient
> {
  /**
   * @param name Binding name (logical id) — the `env` key it resolves to.
   * @param props Rate limit namespace + simple config.
   */
  (name: string, props: RateLimitProps): RateLimitBinding;
}

export const RateLimit = Binding.Service<
  RateLimit,
  { namespaceId: string; simple: { limit: number; period: RateLimitPeriod } }
>({
  id: TypeId,
  defaultName: "RATE_LIMIT",
  parse: (name: string, props: RateLimitProps) => ({
    name,
    namespaceId: String(props.namespaceId),
    simple: props.simple,
  }),
  toWorkerBinding: (binding) => ({
    type: "ratelimit",
    name: binding.name,
    namespaceId: binding.namespaceId,
    simple: binding.simple,
  }),
});

export const isRateLimit = (value: unknown): value is RateLimitBinding =>
  Binding.isBinding(value) && value.kind === TypeId;
