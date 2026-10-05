import type * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Instance } from "./Instance.ts";

export interface GetInstanceRequest extends Omit<
  bigtable.GetProjectsInstancesRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Bigtable `instances.get`.
 *
 * Bind this operation to an {@link Instance} in a Function/Action init
 * phase. Provide {@link GetInstanceHttp}.
 *
 * ### Observing Instances
 * **Example:** Read the bound instance
 * ```typescript
 * const getInstance = yield* GCP.Bigtable.GetInstance(store);
 * const live = yield* getInstance();
 * ```
 *
 * @binding
 * @category Bigtable
 */
export interface GetInstance extends Binding.Service<
  GetInstance,
  "GCP.Bigtable.GetInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetInstanceRequest,
    ) => Effect.Effect<
      bigtable.Instance,
      bigtable.GetProjectsInstancesError,
      RuntimeContext
    >
  >
> {}

export const GetInstance = Binding.Service<GetInstance>(
  "GCP.Bigtable.GetInstance",
);
