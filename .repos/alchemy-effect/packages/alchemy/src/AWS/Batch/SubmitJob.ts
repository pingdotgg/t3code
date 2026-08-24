import type * as batch from "@distilled.cloud/aws/batch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { JobDefinition } from "./JobDefinition.ts";
import type { JobQueue } from "./JobQueue.ts";

/**
 * The queue and job definition are injected by the binding; everything else
 * (name, parameters, container overrides, ...) is the raw distilled request.
 */
export interface SubmitJobRequest extends Omit<
  batch.SubmitJobRequest,
  "jobQueue" | "jobDefinition"
> {}

/**
 * Submit a job to an AWS Batch job queue against a bound job definition —
 * fire-and-forget heavy work from a Lambda or Task.
 *
 * @binding
 * @section Submitting Jobs
 * @example Submit from a Lambda
 * ```typescript
 * const submitJob = yield* Batch.SubmitJob(queue, jobDef);
 * const { jobId } = yield* submitJob({
 *   jobName: "nightly-export",
 *   containerOverrides: { command: ["echo", "hello"] },
 * });
 * ```
 */
export interface SubmitJob extends Binding.Service<
  SubmitJob,
  "AWS.Batch.SubmitJob",
  (
    queue: JobQueue,
    jobDefinition: JobDefinition,
  ) => Effect.Effect<
    (
      request: SubmitJobRequest,
    ) => Effect.Effect<batch.SubmitJobResponse, batch.SubmitJobError>
  >
> {}
export const SubmitJob = Binding.Service<SubmitJob>("AWS.Batch.SubmitJob");
