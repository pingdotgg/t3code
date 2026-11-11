import type * as redis from "@distilled.cloud/gcp/redis_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetInstanceRequest extends Omit<
  redis.GetProjectsLocationsInstancesRequest,
  "name"
> {}

/**
 * Runtime binding for Memorystore Redis `instances.get`.
 *
 * Bind this operation to an {@link Instance} in a Function/Action init
 * phase. Provide {@link GetInstanceHttp}.
 *
 * ### Observing Instances
 * **Example:** Read the bound instance
 * ```typescript
 * const getInstance = yield* GCP.Redis.GetInstance(cache);
 * const live = yield* getInstance();
 * ```
 *
 * @binding
 * @category Redis
 */
export interface GetInstance extends Binding.Service<
  GetInstance,
  "GCP.Redis.GetInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetInstanceRequest,
    ) => Effect.Effect<redis.Instance, redis.GetProjectsLocationsInstancesError, RuntimeContext>
  >
> {}

export const GetInstance = Binding.Service<GetInstance>("GCP.Redis.GetInstance");
