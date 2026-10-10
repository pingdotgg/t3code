import type * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Job } from "./Job.ts";

export interface ResumeJobRequest extends Omit<
  scheduler.ResumeProjectsLocationsJobsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Scheduler `jobs.resume`.
 *
 * Bind this operation to a {@link Job} in a Function/Action init phase.
 * Provide {@link ResumeJobHttp}.
 *
 * Grants `roles/cloudscheduler.admin` on the project: it is the only
 * predefined role with `cloudscheduler.jobs.enable`, and Cloud Scheduler has
 * neither per-job IAM policies nor IAM Conditions on `resource.name`.
 *
 * ### Resuming Jobs
 * **Example:** Resume the bound job
 * ```typescript
 * const resumeJob = yield* GCP.CloudScheduler.ResumeJob(ping);
 * yield* resumeJob();
 * ```
 *
 * @binding
 * @category CloudScheduler
 */
export interface ResumeJob extends Binding.Service<
  ResumeJob,
  "GCP.CloudScheduler.ResumeJob",
  (
    job: Job,
  ) => Effect.Effect<
    (
      request?: ResumeJobRequest,
    ) => Effect.Effect<
      scheduler.Job,
      scheduler.ResumeProjectsLocationsJobsError,
      RuntimeContext
    >
  >
> {}

export const ResumeJob = Binding.Service<ResumeJob>(
  "GCP.CloudScheduler.ResumeJob",
);
