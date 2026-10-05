import * as Layer from "effect/Layer";
import { makeRead } from "../../Redis/index.ts";
import { makeRedisBinding } from "./RedisBinding.ts";
import { ReadRedis } from "./ReadRedis.ts";

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
