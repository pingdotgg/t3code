import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { ReadRedisClient } from "./ReadRedis.ts";
import type { Redis } from "./Redis.ts";
import type { WriteRedisClient } from "./WriteRedis.ts";

/**
 * Bind a {@link Redis} database with read + write access.
 *
 * `ReadWriteRedis` is the Context tag, the type, and the callable —
 * `yield* Fly.ReadWriteRedis(Cache)`. Provide {@link ReadWriteRedisHttp}.
 *
 *
 * ### Read and write
 * **Example:** Round-trip a key
 * ```typescript
 * const cache = yield* Fly.ReadWriteRedis(Cache);
 * yield* cache.set("marker", "hello");
 * const value = yield* cache.get("marker");
 * ```
 *
 * @binding
 */
export interface ReadWriteRedis extends Binding.Service<
  ReadWriteRedis,
  "Fly.ReadWriteRedis",
  (redis: Redis) => Effect.Effect<ReadWriteRedisClient>
> {}

export const ReadWriteRedis =
  Binding.Service<ReadWriteRedis>("Fly.ReadWriteRedis");

export interface ReadWriteRedisClient
  extends ReadRedisClient, WriteRedisClient {}
