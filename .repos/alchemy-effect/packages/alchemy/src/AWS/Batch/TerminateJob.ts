import type * as batch from "@distilled.cloud/aws/batch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { JobQueue } from "./JobQueue.ts";

export interface TerminateJobRequest extends batch.TerminateJobRequest {}

/**
 * Terminate a running (or cancel a queued) AWS Batch job from runtime code.
 *
 * @binding
 * @section Terminating Jobs
 * @example Terminate a job
 * ```typescript
 * const terminateJob = yield* Batch.TerminateJob(queue);
 * yield* terminateJob({ jobId, reason: "superseded" });
 * ```
 */
export interface TerminateJob extends Binding.Service<
  TerminateJob,
  "AWS.Batch.TerminateJob",
  (
    queue: JobQueue,
  ) => Effect.Effect<
    (
      request: TerminateJobRequest,
    ) => Effect.Effect<batch.TerminateJobResponse, batch.TerminateJobError>
  >
> {}
export const TerminateJob = Binding.Service<TerminateJob>(
  "AWS.Batch.TerminateJob",
);
