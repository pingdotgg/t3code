import type * as redis from "@distilled.cloud/gcp/redis_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Instance } from "./Instance.ts";

export interface GetAuthStringRequest extends Omit<
  redis.GetAuthStringProjectsLocationsInstancesRequest,
  "name"
> {}

/**
 * Runtime binding for Memorystore Redis `instances.getAuthString`.
 *
 * Bind this operation to an {@link Instance} in a Function/Action init
 * phase. Provide {@link GetAuthStringHttp}. If AUTH is not enabled the
 * response `authString` is empty. `redis.instances.getAuthString` is only
 * in `roles/redis.admin`, so the host is granted that role on the project
 * under an IAM Condition matching the bound instance.
 *
 * ### Reading AUTH
 * **Example:** Fetch the AUTH string
 * ```typescript
 * const getAuthString = yield* GCP.Redis.GetAuthString(cache);
 * const { authString } = yield* getAuthString();
 * ```
 *
 * @binding
 * @category Redis
 */
export interface GetAuthString extends Binding.Service<
  GetAuthString,
  "GCP.Redis.GetAuthString",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetAuthStringRequest,
    ) => Effect.Effect<
      redis.InstanceAuthString,
      redis.GetAuthStringProjectsLocationsInstancesError,
      RuntimeContext
    >
  >
> {}

export const GetAuthString = Binding.Service<GetAuthString>(
  "GCP.Redis.GetAuthString",
);
