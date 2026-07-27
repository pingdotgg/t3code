import type * as emrc from "@distilled.cloud/aws/emr-containers";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { VirtualCluster } from "./VirtualCluster.ts";

/**
 * Runtime binding for `emr-containers:ListJobRuns`.
 *
 * Lists job runs on the bound {@link VirtualCluster}, optionally filtered by
 * state, name, or creation time. The virtual cluster ID is injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.EMRContainers.ListJobRunsHttp)`.
 * @binding
 * @section Running Jobs
 * @example Count Active Job Runs
 * ```typescript
 * // init
 * const listJobRuns = yield* AWS.EMRContainers.ListJobRuns(virtualCluster);
 *
 * // runtime
 * const { jobRuns } = yield* listJobRuns({
 *   states: ["PENDING", "SUBMITTED", "RUNNING"],
 * });
 * yield* Effect.log(`${jobRuns?.length ?? 0} active job runs`);
 * ```
 */
export interface ListJobRuns extends Binding.Service<
  ListJobRuns,
  "AWS.EMRContainers.ListJobRuns",
  (
    virtualCluster: VirtualCluster,
  ) => Effect.Effect<
    (
      request?: Omit<emrc.ListJobRunsRequest, "virtualClusterId">,
    ) => Effect.Effect<emrc.ListJobRunsResponse, emrc.ListJobRunsError>
  >
> {}
export const ListJobRuns = Binding.Service<ListJobRuns>(
  "AWS.EMRContainers.ListJobRuns",
);
