import * as Layer from "effect/Layer";
import { makeRedisBinding } from "./RedisBinding.ts";
import { makeReadRedisClient } from "./RedisHttp.ts";
import { ReadRedis } from "./ReadRedis.ts";

/**
 * HTTP implementation of {@link ReadRedis}.
 *
 * @layer
 * @provides Fly.ReadRedis
 */
export const ReadRedisHttp = Layer.effect(
  ReadRedis,
  makeRedisBinding({
    makeClient: makeReadRedisClient,
  }),
);
