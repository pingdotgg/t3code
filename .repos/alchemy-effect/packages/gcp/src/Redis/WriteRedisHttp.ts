import { makeWrite } from "@alchemy.run/redis";
import * as Layer from "effect/Layer";
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
