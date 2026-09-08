import * as Layer from "effect/Layer";
import { ReadRedis } from "./ReadRedis.ts";
import { makeRedisBinding } from "./RedisBinding.ts";
import { makeReadRedisClient } from "./RedisHttp.ts";

/**
 * HTTP implementation of {@link ReadRedis}.
 *
 * @layer
 * @provides Railway.ReadRedis
 */
export const ReadRedisHttp = Layer.effect(
  ReadRedis,
  makeRedisBinding({
    makeClient: makeReadRedisClient,
  }),
);
