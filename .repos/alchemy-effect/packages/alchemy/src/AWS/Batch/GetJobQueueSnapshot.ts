import type * as batch from "@distilled.cloud/aws/batch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { JobQueue } from "./JobQueue.ts";

/** The queue is injected by the binding; the request carries nothing else. */
export interface GetJobQueueSnapshotRequest extends Omit<
  batch.GetJobQueueSnapshotRequest,
  "jobQueue"
> {}

/**
 * Snapshot the head of the bound AWS Batch job queue (the next ~100 `RUNNABLE`
 * jobs the scheduler will run, in dispatch order) — queue introspection for
 * dashboards and backpressure decisions from runtime code.
 *
 * @binding
 * @section Inspecting the Queue
 * @example Read the front of the queue
 * ```typescript
 * const getJobQueueSnapshot = yield* Batch.GetJobQueueSnapshot(queue);
 * const { frontOfQueue } = yield* getJobQueueSnapshot();
 * const next = frontOfQueue?.jobs?.[0]?.jobArn;
 * ```
 */
export interface GetJobQueueSnapshot extends Binding.Service<
  GetJobQueueSnapshot,
  "AWS.Batch.GetJobQueueSnapshot",
  (
    queue: JobQueue,
  ) => Effect.Effect<
    (
      request?: GetJobQueueSnapshotRequest,
    ) => Effect.Effect<
      batch.GetJobQueueSnapshotResponse,
      batch.GetJobQueueSnapshotError
    >
  >
> {}
export const GetJobQueueSnapshot = Binding.Service<GetJobQueueSnapshot>(
  "AWS.Batch.GetJobQueueSnapshot",
);
