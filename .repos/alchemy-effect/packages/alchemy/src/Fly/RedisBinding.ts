import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import type { Url } from "../Redis/index.ts";
import type { Resource } from "../Resource.ts";
import type { ServiceBinding } from "./MountVolume.ts";
import { REDIS_URL_ENV, RedisUrlMissing, type Redis } from "./Redis.ts";

/**
 * Shared scaffolding for Upstash Redis bindings.
 *
 * Each `{Op}Http.ts` is a thin `Layer.effect` over {@link makeRedisBinding}.
 * Deploy-time registers the Redis add-on on the host so Service reconcile
 * writes `REDIS_URL`. Runtime commands use that URL internally — callers
 * never read `Config.redacted`.
 *
 * The RESP client lives in `alchemy/Redis`. This file only wires the
 * Fly host binding.
 *
 * NOT exported from `index.ts`.
 */

const isFlyHost = (
  value: unknown,
): value is Resource<string, any, any, ServiceBinding> =>
  typeof value === "object" &&
  value !== null &&
  ((value as { Type?: string }).Type === "Fly.Service" ||
    (value as { Type?: string }).Type === "Fly.Machine");

const asPlain = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) return value;
  if (Redacted.isRedacted(value)) return asPlain(Redacted.value(value));
  return undefined;
};

const redisUrlFromEnv = Config.redacted(REDIS_URL_ENV).pipe(
  Effect.map((value) => Redacted.value(value)),
);

export const makeRedisBinding = <Client>(options: {
  makeClient: (url: Url) => Client;
}) =>
  Effect.succeed(
    Effect.fn(function* (redis: Redis) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFlyHost(host)) {
          yield* host.bind`${redis}`({
            redis: { name: redis.name, id: redis.redisId },
          });
        }
      }

      const url = redisUrlFromEnv.pipe(
        Effect.mapError(
          () =>
            new RedisUrlMissing({
              name: asPlain(redis.name) ?? redis.LogicalId,
            }),
        ),
      );
      return options.makeClient(url);
    }),
  );
