import * as Layer from "effect/Layer";
import { makeRedisBinding } from "./RedisBinding.ts";
import { makeWriteRedisClient } from "./RedisHttp.ts";
import { WriteRedis } from "./WriteRedis.ts";

/**
 * HTTP implementation of {@link WriteRedis}.
 *
 * @layer
 * @product Redis
 * @provides Fly.WriteRedis
 */
export const WriteRedisHttp = Layer.effect(
  WriteRedis,
  makeRedisBinding({
    makeClient: makeWriteRedisClient,
  }),
);
