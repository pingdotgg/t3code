import { makeRead } from "@alchemy.run/redis";
import * as Layer from "effect/Layer";
import { ReadRedis } from "./ReadRedis.ts";
import { makeRedisBinding } from "./RedisBinding.ts";

/**
 * HTTP/RESP implementation of {@link ReadRedis}.
 *
 * @layer
 * @provides GCP.Redis.ReadRedis
 */
export const ReadRedisHttp = Layer.effect(
  ReadRedis,
  makeRedisBinding({
    tag: "GCP.Redis.ReadRedis",
    makeClient: makeRead,
  }),
);
