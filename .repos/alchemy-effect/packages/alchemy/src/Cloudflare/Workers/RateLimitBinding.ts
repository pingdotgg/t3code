import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import type * as Binding from "./Binding.ts";
import { makeBindingLayer } from "./BindingLayer.ts";
import {
  RateLimit,
  RateLimitError,
  type RateLimitClient,
  type RateLimitPeriod,
} from "./RateLimit.ts";

/** The binding value produced by calling {@link RateLimit} (declared on `env` or `yield*`-ed). */
export type RateLimitBinding = Binding.Binding<
  RateLimit["key"],
  RateLimitClient,
  RateLimit
> & {
  readonly namespaceId: string;
  readonly simple: { limit: number; period: RateLimitPeriod };
};

/**
 * The layer that provides the Effect-native interface for the Cloudflare
 * Workers Rate Limit binding.
 *
 * Provide it on the Worker effect (`Effect.provide(Cloudflare.Workers.RateLimitBinding)`)
 * so that yielding a {@link RateLimit} binding attaches the native `ratelimit`
 * binding to the surrounding Worker at deploy time and, at runtime, resolves to
 * the Effect-native {@link RateLimitClient}.
 */
export const RateLimitBinding = makeBindingLayer<
  RateLimit,
  cf.RateLimit,
  RateLimitClient
>(RateLimit, (raw) => ({
  raw,
  limit: (options) =>
    raw.pipe(
      Effect.flatMap((binding) =>
        Effect.tryPromise({
          try: () => binding.limit(options),
          catch: (error) =>
            new RateLimitError({
              message:
                error instanceof Error
                  ? error.message
                  : "Unknown RateLimit error",
              cause: error,
            }),
        }),
      ),
    ),
}));
