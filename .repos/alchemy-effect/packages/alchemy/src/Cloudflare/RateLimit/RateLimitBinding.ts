/// <reference types="@cloudflare/workers-types" />

import type * as cf from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import { type RateLimit as RateLimitLike } from "./RateLimit.ts";

export class RateLimitError extends Data.TaggedError("RateLimitError")<{
  message: string;
  cause: unknown;
}> {}

export interface RateLimitClient {
  raw: Effect.Effect<cf.RateLimit, never, WorkerEnvironment>;
  limit(
    options: Parameters<cf.RateLimit["limit"]>[0],
  ): Effect.Effect<
    Awaited<ReturnType<cf.RateLimit["limit"]>>,
    RateLimitError,
    WorkerEnvironment
  >;
}

export class RateLimitBinding extends Binding.Service<
  RateLimitBinding,
  (rateLimit: RateLimitLike) => Effect.Effect<RateLimitClient>
>()("Cloudflare.RateLimit.Binding") {}

export const RateLimitBindingLive = Layer.effect(
  RateLimitBinding,
  Effect.gen(function* () {
    const Policy = yield* RateLimitBindingPolicy;

    return Effect.fn(function* (rateLimit: RateLimitLike) {
      yield* Policy(rateLimit);
      const raw = WorkerEnvironment.useSync(
        (env) => (env as Record<string, cf.RateLimit>)[rateLimit.name]!,
      );
      return {
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
      } satisfies RateLimitClient;
    });
  }),
);

export class RateLimitBindingPolicy extends Binding.Policy<
  RateLimitBindingPolicy,
  (rateLimit: RateLimitLike) => Effect.Effect<void>
>()("Cloudflare.RateLimit.Binding") {}

export const RateLimitBindingPolicyLive = RateLimitBindingPolicy.layer.succeed(
  Effect.fn(function* (host: ResourceLike, rateLimit: RateLimitLike) {
    if (isWorker(host)) {
      yield* host.bind(rateLimit.name, {
        bindings: [
          {
            type: "ratelimit",
            name: rateLimit.name,
            namespaceId: rateLimit.namespaceId,
            simple: rateLimit.simple,
          } as any,
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(`RateLimitBinding does not support runtime '${host.Type}'`),
      );
    }
  }),
);
