import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import * as Output from "../Output.ts";
import type { Url } from "../Redis/index.ts";
import { UrlMissing as RedisUrlMissing } from "../Redis/index.ts";
import { isRailwayHost } from "./MountVolume.ts";
import type { Redis } from "./Redis.ts";

export const REDIS_URL_ENV = "REDIS_URL";

/**
 * Shared scaffolding for Railway Redis bindings.
 *
 * Each `{Op}Http.ts` is a thin `Layer.effect` over {@link makeRedisBinding}.
 * Deploy-time writes `REDIS_URL` onto the host Service as a Railway
 * reference (`${{RedisName.REDIS_URL}}`). Runtime commands use that URL
 * internally — callers never read `Config.redacted`.
 *
 * The RESP client lives in `alchemy/Redis`. This file only wires the
 * Railway host binding.
 *
 * NOT exported from `index.ts`.
 */

const asPlain = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) return value;
  if (Redacted.isRedacted(value)) return asPlain(Redacted.value(value));
  return undefined;
};

const resolveName = (redis: Redis) =>
  Effect.gen(function* () {
    const value = redis.name as unknown;
    const direct = asPlain(value);
    if (direct !== undefined) return direct;
    if (Output.isOutput(value)) {
      const accessor = yield* value as Output.Output<string>;
      return asPlain(yield* accessor) ?? "";
    }
    if (Effect.isEffect(value)) {
      return asPlain(yield* value as Effect.Effect<unknown>) ?? "";
    }
    return redis.LogicalId;
  });

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
        if (isRailwayHost(host)) {
          // Resolve the physical service name at apply, not at Service
          // init — LogicalId (`Cache`) is not a Railway variable
          // reference. Same Output-in-env pattern as ConnectPostgres.
          yield* host.bind`${redis}`({
            env: {
              [REDIS_URL_ENV]: Output.map(
                Output.asOutput(redis.name as Output.Output<string>),
                (name) => `\${{${name}.${REDIS_URL_ENV}}}`,
              ),
            },
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
