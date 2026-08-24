import type * as deadline from "@distilled.cloud/aws/deadline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/**
 * Runtime binding for `deadline:SearchTasks`.
 *
 * Searches the tasks of the bound {@link Queue} (optionally narrowed to one
 * `jobId`) with filter and sort expressions. The queue's
 * `farmId`/`queueIds: [queueId]` are injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.Deadline.SearchTasksHttp)`.
 * @binding
 * @section Monitoring Tasks
 * @example Page Through A Job's Tasks
 * ```typescript
 * // init — bind the operation to the queue
 * const searchTasks = yield* AWS.Deadline.SearchTasks(queue);
 *
 * // runtime
 * const { tasks, totalResults } = yield* searchTasks({
 *   itemOffset: 0,
 *   jobId,
 * });
 * ```
 */
export interface SearchTasks extends Binding.Service<
  SearchTasks,
  "AWS.Deadline.SearchTasks",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: Omit<deadline.SearchTasksRequest, "farmId" | "queueIds">,
    ) => Effect.Effect<deadline.SearchTasksResponse, deadline.SearchTasksError>
  >
> {}
export const SearchTasks = Binding.Service<SearchTasks>(
  "AWS.Deadline.SearchTasks",
);
