import type * as memcache from "@distilled.cloud/gcp/memcache_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Instance } from "./Instance.ts";

export interface GetInstanceRequest extends Omit<
  memcache.GetProjectsLocationsInstancesRequest,
  "name"
> {}

/**
 * Runtime binding for Memorystore Memcached `instances.get`.
 *
 * Bind this operation to an {@link Instance} in a Function/Action init
 * phase. Provide {@link GetInstanceHttp}.
 *
 * ### Observing Instances
 * **Example:** Read the bound instance
 * ```typescript
 * const getInstance = yield* GCP.Memcache.GetInstance(cache);
 * const live = yield* getInstance();
 * ```
 *
 * @binding
 * @category Memcache
 */
export interface GetInstance extends Binding.Service<
  GetInstance,
  "GCP.Memcache.GetInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetInstanceRequest,
    ) => Effect.Effect<
      memcache.Instance,
      memcache.GetProjectsLocationsInstancesError,
      RuntimeContext
    >
  >
> {}

export const GetInstance = Binding.Service<GetInstance>(
  "GCP.Memcache.GetInstance",
);
