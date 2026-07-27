import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

export interface ListDeadLetterSourceQueuesRequest extends Omit<
  sqs.ListDeadLetterSourceQueuesRequest,
  "QueueUrl"
> {}

/**
 * Runtime binding for `sqs:ListDeadLetterSourceQueues`.
 *
 * Bind this operation to a dead-letter {@link Queue} inside a function
 * runtime to enumerate the source queues whose `redrivePolicy` targets it.
 * The binding grants the host function `sqs:ListDeadLetterSourceQueues` on
 * the queue. Provide the `ListDeadLetterSourceQueuesHttp` layer on the
 * Function to implement the binding.
 * @binding
 * @section Dead-Letter Queue Redrive
 * @example List Source Queues of a Dead-Letter Queue
 * ```typescript
 * // init (provide SQS.ListDeadLetterSourceQueuesHttp on the Function)
 * const listDeadLetterSourceQueues =
 *   yield* SQS.ListDeadLetterSourceQueues(dlq);
 *
 * // runtime
 * const result = yield* listDeadLetterSourceQueues();
 * // result.queueUrls: URLs of every queue using `dlq` as its DLQ
 * ```
 */
export interface ListDeadLetterSourceQueues extends Binding.Service<
  ListDeadLetterSourceQueues,
  "AWS.SQS.ListDeadLetterSourceQueues",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request?: ListDeadLetterSourceQueuesRequest,
    ) => Effect.Effect<
      sqs.ListDeadLetterSourceQueuesResult,
      sqs.ListDeadLetterSourceQueuesError
    >
  >
> {}

export const ListDeadLetterSourceQueues =
  Binding.Service<ListDeadLetterSourceQueues>(
    "AWS.SQS.ListDeadLetterSourceQueues",
  );
