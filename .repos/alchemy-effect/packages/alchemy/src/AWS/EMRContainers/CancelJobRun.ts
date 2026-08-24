import type * as emrc from "@distilled.cloud/aws/emr-containers";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { VirtualCluster } from "./VirtualCluster.ts";

/**
 * Runtime binding for `emr-containers:CancelJobRun`.
 *
 * Cancels a job run on the bound {@link VirtualCluster}. The virtual cluster
 * ID is injected from the binding; pass the job run `id` returned by
 * `StartJobRun`. Provide the implementation with
 * `Effect.provide(AWS.EMRContainers.CancelJobRunHttp)`.
 * @binding
 * @section Running Jobs
 * @example Cancel A Runaway Job
 * ```typescript
 * // init
 * const cancelJobRun = yield* AWS.EMRContainers.CancelJobRun(virtualCluster);
 *
 * // runtime
 * yield* cancelJobRun({ id: jobRunId });
 * ```
 */
export interface CancelJobRun extends Binding.Service<
  CancelJobRun,
  "AWS.EMRContainers.CancelJobRun",
  (
    virtualCluster: VirtualCluster,
  ) => Effect.Effect<
    (
      request: Omit<emrc.CancelJobRunRequest, "virtualClusterId">,
    ) => Effect.Effect<emrc.CancelJobRunResponse, emrc.CancelJobRunError>
  >
> {}
export const CancelJobRun = Binding.Service<CancelJobRun>(
  "AWS.EMRContainers.CancelJobRun",
);
