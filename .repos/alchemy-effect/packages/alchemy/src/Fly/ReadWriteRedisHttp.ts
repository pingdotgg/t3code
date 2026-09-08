import * as Layer from "effect/Layer";
import { makeRedisBinding } from "./RedisBinding.ts";
import { makeReadWriteRedisClient } from "./RedisHttp.ts";
import { ReadWriteRedis } from "./ReadWriteRedis.ts";

/**
 * HTTP implementation of {@link ReadWriteRedis}.
 *
 * @layer
 * @provides Fly.ReadWriteRedis
 */
export const ReadWriteRedisHttp = Layer.effect(
  ReadWriteRedis,
  makeRedisBinding({
    makeClient: makeReadWriteRedisClient,
  }),
);
