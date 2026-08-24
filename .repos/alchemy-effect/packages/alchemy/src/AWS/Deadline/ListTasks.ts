import type * as deadline from "@distilled.cloud/aws/deadline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/**
 * Runtime binding for `deadline:ListTasks`.
 *
 * Enumerates the tasks of a step in the bound {@link Queue} (paginated).
 * The queue's `farmId`/`queueId` are injected from the binding. Provide
 * the implementation with `Effect.provide(AWS.Deadline.ListTasksHttp)`.
 * @binding
 * @section Monitoring Tasks
 * @example List A Step's Tasks
 * ```typescript
 * // init — bind the operation to the queue
 * const listTasks = yield* AWS.Deadline.ListTasks(queue);
 *
 * // runtime
 * const { tasks } = yield* listTasks({ jobId, stepId });
 * ```
 */
export interface ListTasks extends Binding.Service<
  ListTasks,
  "AWS.Deadline.ListTasks",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: Omit<deadline.ListTasksRequest, "farmId" | "queueId">,
    ) => Effect.Effect<deadline.ListTasksResponse, deadline.ListTasksError>
  >
> {}
export const ListTasks = Binding.Service<ListTasks>("AWS.Deadline.ListTasks");
