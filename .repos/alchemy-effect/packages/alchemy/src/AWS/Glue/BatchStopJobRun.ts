import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Job } from "./Job.ts";

export interface BatchStopJobRunRequest extends Omit<
  glue.BatchStopJobRunRequest,
  "JobName"
> {}

/**
 * Runtime binding for `glue:BatchStopJobRun`.
 *
 * Stops one or more in-flight runs of the bound {@link Job}. Per-run
 * failures come back in the response's `Errors` list (the call itself
 * succeeds), so inspect `SuccessfulSubmissions`/`Errors` rather than the
 * error channel. The job name is injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.Glue.BatchStopJobRunHttp)`.
 * @binding
 * @section Running Jobs
 * @example Stop a Run
 * ```typescript
 * // init
 * const batchStopJobRun = yield* AWS.Glue.BatchStopJobRun(job);
 *
 * // runtime
 * const { SuccessfulSubmissions, Errors } = yield* batchStopJobRun({
 *   JobRunIds: [runId],
 * });
 * ```
 */
export interface BatchStopJobRun extends Binding.Service<
  BatchStopJobRun,
  "AWS.Glue.BatchStopJobRun",
  (
    job: Job,
  ) => Effect.Effect<
    (
      request: BatchStopJobRunRequest,
    ) => Effect.Effect<glue.BatchStopJobRunResponse, glue.BatchStopJobRunError>
  >
> {}

export const BatchStopJobRun = Binding.Service<BatchStopJobRun>(
  "AWS.Glue.BatchStopJobRun",
);
