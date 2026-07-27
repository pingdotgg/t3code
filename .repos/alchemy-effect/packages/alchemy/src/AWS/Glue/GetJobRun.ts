import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Job } from "./Job.ts";

export interface GetJobRunRequest extends Omit<
  glue.GetJobRunRequest,
  "JobName"
> {}

/**
 * Runtime binding for `glue:GetJobRun`.
 *
 * Reads the metadata of a single run of the bound {@link Job} — its
 * `JobRunState` (`RUNNING`, `SUCCEEDED`, `FAILED`, `TIMEOUT`, …), timings,
 * and error message — so a function can poll a run it started to a terminal
 * state. The job name is injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.Glue.GetJobRunHttp)`.
 * @binding
 * @section Running Jobs
 * @example Poll a Run to a Terminal State
 * ```typescript
 * // init
 * const getJobRun = yield* AWS.Glue.GetJobRun(job);
 *
 * // runtime
 * const { JobRun } = yield* getJobRun({ RunId: runId });
 * if (JobRun?.JobRunState === "FAILED") {
 *   yield* Effect.logError(JobRun.ErrorMessage ?? "run failed");
 * }
 * ```
 */
export interface GetJobRun extends Binding.Service<
  GetJobRun,
  "AWS.Glue.GetJobRun",
  (
    job: Job,
  ) => Effect.Effect<
    (
      request: GetJobRunRequest,
    ) => Effect.Effect<glue.GetJobRunResponse, glue.GetJobRunError>
  >
> {}

export const GetJobRun = Binding.Service<GetJobRun>("AWS.Glue.GetJobRun");
