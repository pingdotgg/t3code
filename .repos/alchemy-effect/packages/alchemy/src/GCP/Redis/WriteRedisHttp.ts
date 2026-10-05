import * as Layer from "effect/Layer";
import { makeWrite } from "../../Redis/index.ts";
import { makeRedisBinding } from "./RedisBinding.ts";
import { WriteRedis } from "./WriteRedis.ts";

/**
 * HTTP/RESP implementation of {@link WriteRedis}.
 *
 * @layer
 * @provides GCP.Redis.WriteRedis
 */
export const WriteRedisHttp = Layer.effect(
  WriteRedis,
  makeRedisBinding({
    tag: "GCP.Redis.WriteRedis",
    makeClient: makeWrite,
  }),
);
