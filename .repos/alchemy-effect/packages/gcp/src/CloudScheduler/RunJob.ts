import type * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Job } from "./Job.ts";

export interface RunJobRequest extends Omit<scheduler.RunProjectsLocationsJobsRequest, "name"> {}

/**
 * Runtime binding for Cloud Scheduler `jobs.run`.
 *
 * Forces an immediate dispatch even if the job is already running. Bind this
 * operation to a {@link Job} in a Function/Action init phase. Provide
 * {@link RunJobHttp}.
 *
 * ### Running Jobs
 * **Example:** Run the bound job now
 * ```typescript
 * const runJob = yield* GCP.CloudScheduler.RunJob(ping);
 * yield* runJob();
 * ```
 *
 * @binding
 * @category CloudScheduler
 */
export interface RunJob extends Binding.Service<
  RunJob,
  "GCP.CloudScheduler.RunJob",
  (
    job: Job,
  ) => Effect.Effect<
    (
      request?: RunJobRequest,
    ) => Effect.Effect<scheduler.Job, scheduler.RunProjectsLocationsJobsError, RuntimeContext>
  >
> {}

export const RunJob = Binding.Service<RunJob>("GCP.CloudScheduler.RunJob");
