import type * as SVC from "@distilled.cloud/aws/databrew";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Job } from "./Job.ts";

export interface StopJobRunRequest extends Omit<
  SVC.StopJobRunRequest,
  "Name"
> {}

/**
 * Runtime binding for `databrew:StopJobRun` — cancels a run of the bound
 * DataBrew job that is still starting or running.
 * ### Stopping Job Runs
 * **Example:** Stop a Job Run
 * ```typescript
 * const stopJobRun = yield* AWS.DataBrew.StopJobRun(job);
 *
 * yield* stopJobRun({ RunId: runId });
 * ```
 *
 * @binding
 */
export interface StopJobRun extends Binding.Service<
  StopJobRun,
  "AWS.DataBrew.StopJobRun",
  <J extends Job>(
    job: J,
  ) => Effect.Effect<
    (
      request: StopJobRunRequest,
    ) => Effect.Effect<SVC.StopJobRunResponse, SVC.StopJobRunError>
  >
> {}
export const StopJobRun = Binding.Service<StopJobRun>(
  "AWS.DataBrew.StopJobRun",
);
