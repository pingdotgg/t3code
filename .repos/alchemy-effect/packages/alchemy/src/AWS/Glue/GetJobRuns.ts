import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Job } from "./Job.ts";

export interface GetJobRunsRequest extends Omit<
  glue.GetJobRunsRequest,
  "JobName"
> {}

/**
 * Runtime binding for `glue:GetJobRuns`.
 *
 * Lists the runs of the bound {@link Job} (newest first, paginated via
 * `NextToken`), so a function can report run history or find in-flight runs.
 * The job name is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Glue.GetJobRunsHttp)`.
 * @binding
 * @section Running Jobs
 * @example List Recent Runs
 * ```typescript
 * // init
 * const getJobRuns = yield* AWS.Glue.GetJobRuns(job);
 *
 * // runtime
 * const { JobRuns } = yield* getJobRuns({ MaxResults: 10 });
 * const running = (JobRuns ?? []).filter(
 *   (run) => run.JobRunState === "RUNNING",
 * );
 * ```
 */
export interface GetJobRuns extends Binding.Service<
  GetJobRuns,
  "AWS.Glue.GetJobRuns",
  (
    job: Job,
  ) => Effect.Effect<
    (
      request?: GetJobRunsRequest,
    ) => Effect.Effect<glue.GetJobRunsResponse, glue.GetJobRunsError>
  >
> {}

export const GetJobRuns = Binding.Service<GetJobRuns>("AWS.Glue.GetJobRuns");
