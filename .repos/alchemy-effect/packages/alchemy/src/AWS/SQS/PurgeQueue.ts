import type * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/**
 * Runtime binding for `sqs:PurgeQueue`.
 *
 * Bind this operation to a {@link Queue} inside a function runtime to delete
 * every message in the queue in one call. The purge takes up to 60 seconds
 * to complete, and only one purge per queue is allowed every 60 seconds
 * (a second call fails with the typed `PurgeQueueInProgress` error). The
 * binding grants the host function `sqs:PurgeQueue` on the queue. Provide
 * the `PurgeQueueHttp` layer on the Function to implement the binding.
 * @binding
 * @section Purging a Queue
 * @example Purge All Messages
 * ```typescript
 * // init (provide SQS.PurgeQueueHttp on the Function)
 * const purgeQueue = yield* SQS.PurgeQueue(queue);
 *
 * // runtime: drop everything currently in the queue
 * yield* purgeQueue();
 * ```
 */
export interface PurgeQueue extends Binding.Service<
  PurgeQueue,
  "AWS.SQS.PurgeQueue",
  (
    queue: Queue,
  ) => Effect.Effect<
    () => Effect.Effect<sqs.PurgeQueueResponse, sqs.PurgeQueueError>
  >
> {}

export const PurgeQueue = Binding.Service<PurgeQueue>("AWS.SQS.PurgeQueue");
