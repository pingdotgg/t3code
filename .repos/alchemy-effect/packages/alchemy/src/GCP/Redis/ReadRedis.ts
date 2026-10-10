import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReadClient } from "../../Redis/index.ts";
import type { Instance } from "./Instance.ts";

/**
 * Bind a Memorystore {@link Instance} with read access.
 *
 * Uses the shared `alchemy/Redis` RESP client. Provide
 * {@link ReadRedisHttp}. The host receives only the instance endpoint; when
 * AUTH is enabled the runtime fetches the AUTH string with
 * `instances.getAuthString`, so the host is granted `roles/redis.admin`
 * (the only predefined role with that permission) on the project under an
 * IAM Condition matching this instance.
 *
 * ### Read
 * **Example:** Get a key
 * ```typescript
 * const cache = yield* GCP.Redis.ReadRedis(Memorystore);
 * const value = yield* cache.get("marker");
 * ```
 *
 * @binding
 * @category Redis
 */
export interface ReadRedis extends Binding.Service<
  ReadRedis,
  "GCP.Redis.ReadRedis",
  (instance: Instance) => Effect.Effect<ReadRedisClient>
> {}

export const ReadRedis = Binding.Service<ReadRedis>("GCP.Redis.ReadRedis");

export type ReadRedisClient = ReadClient;
