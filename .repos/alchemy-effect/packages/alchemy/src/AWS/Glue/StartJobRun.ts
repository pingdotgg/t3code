import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Job } from "./Job.ts";

export interface StartJobRunRequest extends Omit<
  glue.StartJobRunRequest,
  "JobName"
> {}

/**
 * Starts a run of a Glue job definition.
 *
 * Grants `glue:StartJobRun` and `glue:GetJobRun` on the bound job. Returns the
 * `JobRunId`; poll `getJobRun` for the run's terminal state (`SUCCEEDED`,
 * `FAILED`, `TIMEOUT`, …).
 * @binding
 * @section Running Jobs
 * Provide the `StartJobRunHttp` implementation layer on the Function effect
 * (`.pipe(Effect.provide(AWS.Glue.StartJobRunHttp))`), bind the job in the
 * init phase, then start runs at runtime.
 *
 * @example Start a job run from a handler
 * ```typescript
 * // init
 * const startJobRun = yield* AWS.Glue.StartJobRun(job);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const { JobRunId } = yield* startJobRun({
 *       Arguments: { "--input": "s3://my-bucket/input/" },
 *     });
 *     return HttpServerResponse.json({ JobRunId });
 *   }),
 * };
 * ```
 */
export interface StartJobRun extends Binding.Service<
  StartJobRun,
  "AWS.Glue.StartJobRun",
  (
    job: Job,
  ) => Effect.Effect<
    (
      request?: StartJobRunRequest,
    ) => Effect.Effect<glue.StartJobRunResponse, glue.StartJobRunError>
  >
> {}

export const StartJobRun = Binding.Service<StartJobRun>("AWS.Glue.StartJobRun");
