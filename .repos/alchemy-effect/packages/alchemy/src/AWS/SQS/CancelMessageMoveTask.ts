import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

export interface CancelMessageMoveTaskRequest
  extends sqs.CancelMessageMoveTaskRequest {}

/**
 * Runtime binding for `sqs:CancelMessageMoveTask` (dead-letter queue
 * redrive).
 *
 * Bind this operation to the dead-letter {@link Queue} whose move task
 * should be cancellable. Cancellation only stops messages that have not been
 * moved yet; a task that already finished fails with the typed
 * `ResourceNotFoundException`. The binding grants the host function
 * `sqs:CancelMessageMoveTask` on the queue. Provide the
 * `CancelMessageMoveTaskHttp` layer on the Function to implement the
 * binding.
 * @binding
 * @section Dead-Letter Queue Redrive
 * @example Cancel a Running Redrive
 * ```typescript
 * // init (provide SQS.CancelMessageMoveTaskHttp on the Function)
 * const cancelMessageMoveTask = yield* SQS.CancelMessageMoveTask(dlq);
 *
 * // runtime
 * yield* cancelMessageMoveTask({ TaskHandle: taskHandle });
 * ```
 */
export interface CancelMessageMoveTask extends Binding.Service<
  CancelMessageMoveTask,
  "AWS.SQS.CancelMessageMoveTask",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: CancelMessageMoveTaskRequest,
    ) => Effect.Effect<
      sqs.CancelMessageMoveTaskResult,
      sqs.CancelMessageMoveTaskError
    >
  >
> {}

export const CancelMessageMoveTask = Binding.Service<CancelMessageMoveTask>(
  "AWS.SQS.CancelMessageMoveTask",
);
