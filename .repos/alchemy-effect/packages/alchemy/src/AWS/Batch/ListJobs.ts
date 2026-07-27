import type * as batch from "@distilled.cloud/aws/batch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { JobQueue } from "./JobQueue.ts";

/**
 * The queue is injected by the binding; filter by `jobStatus` (default
 * `RUNNING`), `filters`, or paginate with `nextToken`/`maxResults`.
 */
export interface ListJobsRequest extends Omit<
  batch.ListJobsRequest,
  "jobQueue"
> {}

/**
 * List AWS Batch jobs in the bound job queue from runtime code.
 * `batch:ListJobs` has no resource-level IAM, so the policy is
 * service-scoped; the queue anchors the binding and is injected as the
 * `jobQueue` selector.
 *
 * @binding
 * @section Listing Jobs
 * @example List runnable jobs in the queue
 * ```typescript
 * const listJobs = yield* Batch.ListJobs(queue);
 * const { jobSummaryList } = yield* listJobs({ jobStatus: "RUNNABLE" });
 * ```
 */
export interface ListJobs extends Binding.Service<
  ListJobs,
  "AWS.Batch.ListJobs",
  (
    queue: JobQueue,
  ) => Effect.Effect<
    (
      request?: ListJobsRequest,
    ) => Effect.Effect<batch.ListJobsResponse, batch.ListJobsError>
  >
> {}
export const ListJobs = Binding.Service<ListJobs>("AWS.Batch.ListJobs");
