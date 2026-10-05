import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WriteClient } from "../../Redis/index.ts";
import type { Instance } from "./Instance.ts";

/**
 * Bind a Memorystore {@link Instance} with write access.
 *
 * Uses the shared `alchemy/Redis` RESP client. Provide
 * {@link WriteRedisHttp}.
 *
 * @binding
 * @category Redis
 */
export interface WriteRedis extends Binding.Service<
  WriteRedis,
  "GCP.Redis.WriteRedis",
  (instance: Instance) => Effect.Effect<WriteRedisClient>
> {}

export const WriteRedis = Binding.Service<WriteRedis>("GCP.Redis.WriteRedis");

export type WriteRedisClient = WriteClient;
