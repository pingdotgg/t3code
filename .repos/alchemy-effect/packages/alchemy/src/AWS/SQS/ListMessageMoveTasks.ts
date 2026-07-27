import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

export interface ListMessageMoveTasksRequest extends Omit<
  sqs.ListMessageMoveTasksRequest,
  "SourceArn"
> {}

/**
 * Runtime binding for `sqs:ListMessageMoveTasks` (dead-letter queue
 * redrive).
 *
 * Bind this operation to a dead-letter {@link Queue} inside a function
 * runtime to inspect the most recent message move tasks (up to 10) whose
 * source is that queue — including their status, progress counters, and
 * `TaskHandle` for cancellation. The binding grants the host function
 * `sqs:ListMessageMoveTasks` on the queue. Provide the
 * `ListMessageMoveTasksHttp` layer on the Function to implement the binding.
 * @binding
 * @section Dead-Letter Queue Redrive
 * @example Inspect Redrive Progress
 * ```typescript
 * // init (provide SQS.ListMessageMoveTasksHttp on the Function)
 * const listMessageMoveTasks = yield* SQS.ListMessageMoveTasks(dlq);
 *
 * // runtime
 * const result = yield* listMessageMoveTasks();
 * for (const task of result.Results ?? []) {
 *   // task.Status, task.ApproximateNumberOfMessagesMoved, task.TaskHandle
 * }
 * ```
 */
export interface ListMessageMoveTasks extends Binding.Service<
  ListMessageMoveTasks,
  "AWS.SQS.ListMessageMoveTasks",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request?: ListMessageMoveTasksRequest,
    ) => Effect.Effect<
      sqs.ListMessageMoveTasksResult,
      sqs.ListMessageMoveTasksError
    >
  >
> {}

export const ListMessageMoveTasks = Binding.Service<ListMessageMoveTasks>(
  "AWS.SQS.ListMessageMoveTasks",
);
