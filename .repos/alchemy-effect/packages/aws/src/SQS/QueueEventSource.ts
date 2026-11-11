import * as Binding from "alchemy/Binding";
import type * as lambda from "aws-lambda";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

export type SQSRecord = lambda.SQSRecord;

export type SQSEvent = lambda.SQSEvent;

export interface MessagesProps extends QueueEventSourceProps {
  /**
   * How long each `ReceiveMessage` long-polls for messages when using the
   * process (run) path (e.g. `"20 seconds"`). Rounded to whole seconds on
   * the wire.
   * @default 20 seconds
   */
  waitTime?: Duration.Input;
  /**
   * Maximum number of messages to receive per poll when using the process (run) path.
   * @default 10
   */
  maxNumberOfMessages?: number;
}

/**
 * Lambda's partial-batch response for SQS. Every message listed in
 * `batchItemFailures` (by `itemIdentifier` = `messageId`) is retried; every
 * other message in the batch is deleted.
 */
export type SQSBatchResponse = lambda.SQSBatchResponse;

/**
 * Handler for one delivered batch of SQS messages: receives the
 * {@link SQSEvent} and returns Lambda's {@link SQSBatchResponse} (or `void`
 * when every message succeeded). A failure or defect retries the whole batch.
 */
export type QueueMessagesHandler<E = never, Req = never> = (
  event: SQSEvent,
) => Effect.Effect<SQSBatchResponse | void, E, Req>;

/**
 * Subscribe an Effect handler to batches of messages delivered from an SQS
 * {@link Queue}.
 *
 * The handler receives the {@link SQSEvent} and returns Lambda's
 * {@link SQSBatchResponse}: list the `messageId` of each message that failed
 * in `batchItemFailures` and only those are retried. Return `void` when every
 * message succeeded. If the handler fails, the whole batch is retried.
 *
 * Each batch runs inside a `process <queue>` span (`SpanKind.CONSUMER`) linked
 * to the `traceparent` message attribute of each message that carries one.
 *
 * @param queue The SQS queue to consume messages from.
 * @param props Optional event-source configuration.
 * @param process The batch handler (last argument).
 *
 * @example Report only the failed messages
 * ```typescript
 * yield* SQS.consumeQueueMessages(
 *   queue,
 *   Effect.fn(function* (event) {
 *     const failed = yield* Effect.filter(
 *       event.Records,
 *       (record) =>
 *         Effect.try(() => JSON.parse(record.body)).pipe(
 *           Effect.flatMap((order) => putItem({ Item: { id: { S: order.id } } })),
 *           Effect.as(false),
 *           Effect.catchCause(() => Effect.succeed(true)),
 *         ),
 *       { concurrency: "unbounded" },
 *     );
 *     return {
 *       batchItemFailures: failed.map((record) => ({ itemIdentifier: record.messageId })),
 *     };
 *   }),
 * );
 * ```
 *
 * @example Process the whole batch at once
 * ```typescript
 * const sink = yield* SQS.QueueSink(results);
 *
 * yield* SQS.consumeQueueMessages(
 *   queue,
 *   { batchSize: 10 },
 *   Effect.fn(function* (event) {
 *     // a failure retries the whole batch
 *     yield* Stream.fromIterable(event.Records).pipe(
 *       Stream.map((record) => ({ MessageBody: record.body })),
 *       Stream.run(sink),
 *     );
 *   }),
 * );
 * ```
 */
export function consumeQueueMessages<Q extends Queue, E = never, Req = never, ResourceReq = never>(
  queue: Q | Effect.Effect<Q, never, ResourceReq>,
  process: QueueMessagesHandler<E, Req>,
): Effect.Effect<void, never, QueueEventSource | ResourceReq>;
export function consumeQueueMessages<Q extends Queue, E = never, Req = never, ResourceReq = never>(
  queue: Q | Effect.Effect<Q, never, ResourceReq>,
  props: MessagesProps,
  process: QueueMessagesHandler<E, Req>,
): Effect.Effect<void, never, QueueEventSource | ResourceReq>;
export function consumeQueueMessages<Q extends Queue, E = never, Req = never, ResourceReq = never>(
  queue: Q | Effect.Effect<Q, never, ResourceReq>,
  propsOrProcess: MessagesProps | QueueMessagesHandler<E, Req>,
  maybeProcess?: QueueMessagesHandler<E, Req>,
): Effect.Effect<void, never, QueueEventSource | ResourceReq> {
  const [props, process] =
    typeof propsOrProcess === "function"
      ? [{} as MessagesProps, propsOrProcess]
      : [propsOrProcess, maybeProcess!];
  // Accept the queue or the Effect that declares it, like bindings do.
  const resolved = Effect.isEffect(queue) ? queue : Effect.succeed(queue);
  return resolved.pipe(
    Effect.flatMap((value) => QueueEventSource.use((source) => source(value, props, process))),
  );
}

/**
 * Event source connecting an SQS {@link Queue} to the hosting compute
 * (Lambda function or ServerHost process).
 *
 * The contract is a `Binding.Service`; the host-specific implementation
 * layers are `Lambda.QueueEventSource` (event-source mapping + runtime
 * dispatch) and `AWS.Server.SQSQueueEventSource` (long-poll receive loop).
 * Consume it through the {@link consumeQueueMessages} helper.
 * ### Consuming a Queue
 * **Example:** Consume Messages in a Lambda Function
 * ```typescript
 * export default WorkerFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* SQS.Queue("Jobs");
 *
 *     // registers the event-source mapping and the runtime dispatcher
 *     yield* SQS.consumeQueueMessages(
 *       queue,
 *       { batchSize: 10 },
 *       Effect.fn(function* (event) {
 *         for (const record of event.Records) {
 *           yield* Effect.log(record.body);
 *         }
 *       }),
 *     );
 *   }).pipe(Effect.provide(Lambda.QueueEventSource)),
 * );
 * ```
 *
 * @binding
 */
export interface QueueEventSource extends Binding.Service<
  QueueEventSource,
  "AWS.SQS.QueueEventSource",
  QueueEventSourceService
> {}

export const QueueEventSource = Binding.Service<QueueEventSource>("AWS.SQS.QueueEventSource");

export interface QueueEventSourceProps {
  /**
   * The maximum number of records in each batch that Lambda pulls from the queue.
   * @default 10
   */
  batchSize?: number;
  /**
   * The maximum amount of time that Lambda spends gathering records before
   * invoking the function (e.g. `"5 seconds"`). Rounded to whole seconds on
   * the wire.
   * @default 0
   */
  maximumBatchingWindow?: Duration.Input;
}

export type QueueEventSourceService = <E = never, Req = never>(
  queue: Queue,
  props: MessagesProps,
  process: QueueMessagesHandler<E, Req>,
) => Effect.Effect<void, never, never>;
