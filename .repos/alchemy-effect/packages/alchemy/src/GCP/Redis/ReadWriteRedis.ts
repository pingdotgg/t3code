import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReadWriteClient } from "../../Redis/index.ts";
import type { Instance } from "./Instance.ts";

/**
 * Bind a Memorystore {@link Instance} with read + write access.
 *
 * Uses the shared `alchemy/Redis` RESP client. Provide
 * {@link ReadWriteRedisHttp}.
 *
 * ### Read/Write
 * **Example:** Set then get
 * ```typescript
 * const cache = yield* GCP.Redis.ReadWriteRedis(Memorystore);
 * yield* cache.set("marker", "hello");
 * const value = yield* cache.get("marker");
 * ```
 *
 * @binding
 * @category Redis
 */
export interface ReadWriteRedis extends Binding.Service<
  ReadWriteRedis,
  "GCP.Redis.ReadWriteRedis",
  (instance: Instance) => Effect.Effect<ReadWriteRedisClient>
> {}

export const ReadWriteRedis = Binding.Service<ReadWriteRedis>(
  "GCP.Redis.ReadWriteRedis",
);

export type ReadWriteRedisClient = ReadWriteClient;
