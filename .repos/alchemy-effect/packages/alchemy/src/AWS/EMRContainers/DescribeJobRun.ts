import type * as emrc from "@distilled.cloud/aws/emr-containers";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { VirtualCluster } from "./VirtualCluster.ts";

/**
 * Runtime binding for `emr-containers:DescribeJobRun`.
 *
 * Reads a job run on the bound {@link VirtualCluster} — its state
 * (`PENDING` → `RUNNING` → `COMPLETED`/`FAILED`/`CANCELLED`), failure
 * reason, and the resolved driver/configuration. The virtual cluster ID is
 * injected from the binding; pass the job run `id` returned by
 * `StartJobRun`. Provide the implementation with
 * `Effect.provide(AWS.EMRContainers.DescribeJobRunHttp)`.
 * @binding
 * @section Running Jobs
 * @example Poll A Job Run Until It Finishes
 * ```typescript
 * // init
 * const describeJobRun = yield* AWS.EMRContainers.DescribeJobRun(virtualCluster);
 *
 * // runtime
 * const { jobRun } = yield* describeJobRun({ id: jobRunId }).pipe(
 *   Effect.repeat({
 *     schedule: Schedule.spaced("15 seconds"),
 *     until: (r) =>
 *       r.jobRun?.state === "COMPLETED" || r.jobRun?.state === "FAILED",
 *     times: 40,
 *   }),
 * );
 * ```
 */
export interface DescribeJobRun extends Binding.Service<
  DescribeJobRun,
  "AWS.EMRContainers.DescribeJobRun",
  (
    virtualCluster: VirtualCluster,
  ) => Effect.Effect<
    (
      request: Omit<emrc.DescribeJobRunRequest, "virtualClusterId">,
    ) => Effect.Effect<emrc.DescribeJobRunResponse, emrc.DescribeJobRunError>
  >
> {}
export const DescribeJobRun = Binding.Service<DescribeJobRun>(
  "AWS.EMRContainers.DescribeJobRun",
);
