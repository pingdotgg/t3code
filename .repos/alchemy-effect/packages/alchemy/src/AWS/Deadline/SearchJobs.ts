import type * as deadline from "@distilled.cloud/aws/deadline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/**
 * Runtime binding for `deadline:SearchJobs`.
 *
 * Searches the jobs of the bound {@link Queue} with filter and sort
 * expressions (name, status, user, parameters, dates). The queue's
 * `farmId`/`queueIds: [queueId]` are injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.Deadline.SearchJobsHttp)`.
 * @binding
 * @section Monitoring Jobs
 * @example Find Failed Jobs
 * ```typescript
 * // init — bind the operation to the queue
 * const searchJobs = yield* AWS.Deadline.SearchJobs(queue);
 *
 * // runtime
 * const { jobs } = yield* searchJobs({
 *   itemOffset: 0,
 *   filterExpressions: {
 *     operator: "AND",
 *     filters: [
 *       {
 *         stringFilter: {
 *           name: "TASK_RUN_STATUS",
 *           operator: "EQUAL",
 *           value: "FAILED",
 *         },
 *       },
 *     ],
 *   },
 * });
 * ```
 */
export interface SearchJobs extends Binding.Service<
  SearchJobs,
  "AWS.Deadline.SearchJobs",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: Omit<deadline.SearchJobsRequest, "farmId" | "queueIds">,
    ) => Effect.Effect<deadline.SearchJobsResponse, deadline.SearchJobsError>
  >
> {}
export const SearchJobs = Binding.Service<SearchJobs>(
  "AWS.Deadline.SearchJobs",
);
