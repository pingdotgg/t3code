import * as Layer from "effect/Layer";
import { makeReadWrite } from "../../Redis/index.ts";
import { makeRedisBinding } from "./RedisBinding.ts";
import { ReadWriteRedis } from "./ReadWriteRedis.ts";

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
