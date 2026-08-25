import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

export interface StartMessageMoveTaskRequest extends Omit<
  sqs.StartMessageMoveTaskRequest,
  "SourceArn" | "DestinationArn"
> {}

/**
 * Runtime binding for `sqs:StartMessageMoveTask` (dead-letter queue
 * redrive).
 *
 * Bind this operation to a dead-letter {@link Queue} (the redrive *source*)
 * inside a function runtime to start moving its messages. Redrive requires
 * more than the start permission alone, so the binding grants the host
 * function `sqs:StartMessageMoveTask`, `sqs:ReceiveMessage`,
 * `sqs:DeleteMessage`, and `sqs:GetQueueAttributes` on the source queue.
 *
 * Pass a `destination` Queue at bind time to redrive into a specific queue
 * (grants `sqs:SendMessage` + `sqs:GetQueueAttributes` on it and injects its
 * ARN as `DestinationArn`). Without a destination, messages are redriven to
 * their original source queues — which requires `sqs:SendMessage` on those
 * queues, so the binding grants `sqs:SendMessage` on `*` in that mode.
 *
 * Provide the `StartMessageMoveTaskHttp` layer on the Function to implement
 * the binding.
 * @binding
 * @section Dead-Letter Queue Redrive
 * @example Redrive a DLQ into a Specific Queue
 * ```typescript
 * // init (provide SQS.StartMessageMoveTaskHttp on the Function)
 * const startMessageMoveTask = yield* SQS.StartMessageMoveTask(dlq, {
 *   destination: ordersQueue,
 * });
 *
 * // runtime
 * const { TaskHandle } = yield* startMessageMoveTask();
 * ```
 *
 * @example Rate-Limited Redrive
 * ```typescript
 * yield* startMessageMoveTask({ MaxNumberOfMessagesPerSecond: 10 });
 * ```
 */
export interface StartMessageMoveTask extends Binding.Service<
  StartMessageMoveTask,
  "AWS.SQS.StartMessageMoveTask",
  (
    source: Queue,
    options?: {
      /**
       * The queue messages are redriven into. When omitted, messages are
       * moved back to their original source queues (and the binding grants
       * `sqs:SendMessage` on `*`).
       */
      destination?: Queue;
    },
  ) => Effect.Effect<
    (
      request?: StartMessageMoveTaskRequest,
    ) => Effect.Effect<
      sqs.StartMessageMoveTaskResult,
      sqs.StartMessageMoveTaskError
    >
  >
> {}

export const StartMessageMoveTask = Binding.Service<StartMessageMoveTask>(
  "AWS.SQS.StartMessageMoveTask",
);
