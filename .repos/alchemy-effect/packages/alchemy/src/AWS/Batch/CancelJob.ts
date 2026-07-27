import type * as batch from "@distilled.cloud/aws/batch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { JobQueue } from "./JobQueue.ts";

export interface CancelJobRequest extends batch.CancelJobRequest {}

/**
 * Cancel a queued AWS Batch job from runtime code. Jobs in `SUBMITTED`,
 * `PENDING`, or `RUNNABLE` state are cancelled; jobs that already progressed
 * to `STARTING`/`RUNNING` are NOT cancelled (use `TerminateJob` for those) —
 * the request still succeeds.
 *
 * @binding
 * @section Cancelling Jobs
 * @example Cancel a queued job
 * ```typescript
 * const cancelJob = yield* Batch.CancelJob(queue);
 * yield* cancelJob({ jobId, reason: "superseded" });
 * ```
 */
export interface CancelJob extends Binding.Service<
  CancelJob,
  "AWS.Batch.CancelJob",
  (
    queue: JobQueue,
  ) => Effect.Effect<
    (
      request: CancelJobRequest,
    ) => Effect.Effect<batch.CancelJobResponse, batch.CancelJobError>
  >
> {}
export const CancelJob = Binding.Service<CancelJob>("AWS.Batch.CancelJob");
