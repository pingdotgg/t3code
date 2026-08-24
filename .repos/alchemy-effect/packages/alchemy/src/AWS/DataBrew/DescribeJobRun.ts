import type * as SVC from "@distilled.cloud/aws/databrew";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Job } from "./Job.ts";

export interface DescribeJobRunRequest extends Omit<
  SVC.DescribeJobRunRequest,
  "Name"
> {}

/**
 * Runtime binding for `databrew:DescribeJobRun` — reads the state,
 * timings, and outputs of one run of the bound DataBrew job.
 * @binding
 * @section Observing Job Runs
 * @example Poll a Run's State
 * ```typescript
 * const describeJobRun = yield* AWS.DataBrew.DescribeJobRun(job);
 *
 * const run = yield* describeJobRun({ RunId: runId });
 * // run.State: "STARTING" | "RUNNING" | "SUCCEEDED" | ...
 * ```
 */
export interface DescribeJobRun extends Binding.Service<
  DescribeJobRun,
  "AWS.DataBrew.DescribeJobRun",
  <J extends Job>(
    job: J,
  ) => Effect.Effect<
    (
      request: DescribeJobRunRequest,
    ) => Effect.Effect<SVC.DescribeJobRunResponse, SVC.DescribeJobRunError>
  >
> {}
export const DescribeJobRun = Binding.Service<DescribeJobRun>(
  "AWS.DataBrew.DescribeJobRun",
);
