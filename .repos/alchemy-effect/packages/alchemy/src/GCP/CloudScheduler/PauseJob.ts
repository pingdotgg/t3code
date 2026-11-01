import type * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Job } from "./Job.ts";

export interface PauseJobRequest extends Omit<
  scheduler.PauseProjectsLocationsJobsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Scheduler `jobs.pause`.
 *
 * Bind this operation to a {@link Job} in a Function/Action init phase.
 * Provide {@link PauseJobHttp}.
 *
 * Grants `roles/cloudscheduler.admin` on the project: it is the only
 * predefined role with `cloudscheduler.jobs.pause`, and Cloud Scheduler has
 * neither per-job IAM policies nor IAM Conditions on `resource.name`.
 *
 * ### Pausing Jobs
 * **Example:** Pause the bound job
 * ```typescript
 * const pauseJob = yield* GCP.CloudScheduler.PauseJob(ping);
 * yield* pauseJob();
 * ```
 *
 * @binding
 * @category CloudScheduler
 */
export interface PauseJob extends Binding.Service<
  PauseJob,
  "GCP.CloudScheduler.PauseJob",
  (
    job: Job,
  ) => Effect.Effect<
    (
      request?: PauseJobRequest,
    ) => Effect.Effect<
      scheduler.Job,
      scheduler.PauseProjectsLocationsJobsError,
      RuntimeContext
    >
  >
> {}

export const PauseJob = Binding.Service<PauseJob>(
  "GCP.CloudScheduler.PauseJob",
);
