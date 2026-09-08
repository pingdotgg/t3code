import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { WriteClient } from "../Redis/index.ts";
import type { Redis } from "./Redis.ts";

/**
 * Bind a {@link Redis} database with write access (`set`, `del`).
 *
 * `WriteRedis` is the Context tag, the type, and the callable —
 * `yield* Railway.WriteRedis(Cache)`. Provide {@link WriteRedisHttp}.
 *
 *
 * ### Write
 * **Example:** Set a key
 * ```typescript
 * const cache = yield* Railway.WriteRedis(Cache);
 * yield* cache.set("marker", "hello");
 * ```
 *
 * @binding
 */
export interface WriteRedis extends Binding.Service<
  WriteRedis,
  "Railway.WriteRedis",
  (redis: Redis) => Effect.Effect<WriteRedisClient>
> {}

export const WriteRedis = Binding.Service<WriteRedis>("Railway.WriteRedis");

export type WriteRedisClient = WriteClient;
