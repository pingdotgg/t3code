import type * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetInstanceRequest extends Omit<
  alloydb.GetProjectsLocationsClustersInstancesRequest,
  "name"
> {}

/**
 * Runtime binding for AlloyDB `instances.get`.
 *
 * Bind this operation to an {@link Instance} in a Function/Action init
 * phase. Provide {@link GetInstanceHttp}.
 *
 * ### Observing Instances
 * **Example:** Read the bound instance
 * ```typescript
 * const getInstance = yield* GCP.AlloyDB.GetInstance(primary);
 * const live = yield* getInstance();
 * ```
 *
 * @binding
 * @category AlloyDB
 */
export interface GetInstance extends Binding.Service<
  GetInstance,
  "GCP.AlloyDB.GetInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetInstanceRequest,
    ) => Effect.Effect<
      alloydb.Instance,
      alloydb.GetProjectsLocationsClustersInstancesError,
      RuntimeContext
    >
  >
> {}

export const GetInstance = Binding.Service<GetInstance>("GCP.AlloyDB.GetInstance");
