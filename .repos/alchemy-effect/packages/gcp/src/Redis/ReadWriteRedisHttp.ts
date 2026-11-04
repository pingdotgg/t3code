import { makeReadWrite } from "@alchemy.run/redis";
import * as Layer from "effect/Layer";
import { ReadWriteRedis } from "./ReadWriteRedis.ts";
import { makeRedisBinding } from "./RedisBinding.ts";

/**
 * HTTP/RESP implementation of {@link ReadWriteRedis}.
 *
 * @layer
 * @provides GCP.Redis.ReadWriteRedis
 */
export const ReadWriteRedisHttp = Layer.effect(
  ReadWriteRedis,
  makeRedisBinding({
    tag: "GCP.Redis.ReadWriteRedis",
    makeClient: makeReadWrite,
  }),
);
