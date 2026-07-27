import type * as deadline from "@distilled.cloud/aws/deadline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/**
 * Runtime binding for `deadline:ListJobs`.
 *
 * Enumerates the jobs in the bound {@link Queue} (paginated). The queue's
 * `farmId`/`queueId` are injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.Deadline.ListJobsHttp)`.
 * @binding
 * @section Monitoring Jobs
 * @example List The Queue's Jobs
 * ```typescript
 * // init — bind the operation to the queue
 * const listJobs = yield* AWS.Deadline.ListJobs(queue);
 *
 * // runtime
 * const { jobs } = yield* listJobs();
 * ```
 */
export interface ListJobs extends Binding.Service<
  ListJobs,
  "AWS.Deadline.ListJobs",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request?: Omit<deadline.ListJobsRequest, "farmId" | "queueId">,
    ) => Effect.Effect<deadline.ListJobsResponse, deadline.ListJobsError>
  >
> {}
export const ListJobs = Binding.Service<ListJobs>("AWS.Deadline.ListJobs");
