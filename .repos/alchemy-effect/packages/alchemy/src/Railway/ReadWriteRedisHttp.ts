import * as Layer from "effect/Layer";
import { ReadWriteRedis } from "./ReadWriteRedis.ts";
import { makeRedisBinding } from "./RedisBinding.ts";
import { makeReadWriteRedisClient } from "./RedisHttp.ts";

/**
 * HTTP implementation of {@link ReadWriteRedis}.
 *
 * @layer
 * @provides Railway.ReadWriteRedis
 */
export const ReadWriteRedisHttp = Layer.effect(
  ReadWriteRedis,
  makeRedisBinding({
    makeClient: makeReadWriteRedisClient,
  }),
);
