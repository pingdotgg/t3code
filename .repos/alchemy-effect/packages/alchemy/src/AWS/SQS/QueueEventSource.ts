import type * as lambda from "aws-lambda";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

export type SQSRecord = lambda.SQSRecord;

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

type MessagesHandler<Req> = (
  stream: Stream.Stream<SQSRecord>,
) => Effect.Effect<void, never, Req>;

/**
 * Subscribe an Effect handler to messages produced by an SQS {@link Queue}.
 *
 * @param queue The SQS queue to consume messages from.
 * @param props Optional event-source configuration.
 * @param process The handler invoked with a stream of SQS records (last argument).
 *
 * @example
 * ```typescript
 * yield* SQS.consumeQueueMessages(queue, (records) =>
 *   records.pipe(Stream.runForEach((record) => Effect.log(record.body))),
 * );
 * ```
 *
 * @example With batching configuration
 * ```typescript
 * yield* SQS.consumeQueueMessages(queue, { batchSize: 10 }, (records) =>
 *   records.pipe(
 *     Stream.map((record) => ({ MessageBody: record.body })),
 *     Stream.run(sink),
 *     Effect.orDie,
 *   ),
 * );
 * ```
 */
export function consumeQueueMessages<Q extends Queue, Req = never>(
  queue: Q,
  process: MessagesHandler<Req>,
): Effect.Effect<void, never, QueueEventSource>;
export function consumeQueueMessages<Q extends Queue, Req = never>(
  queue: Q,
  props: MessagesProps,
  process: MessagesHandler<Req>,
): Effect.Effect<void, never, QueueEventSource>;
export function consumeQueueMessages<Q extends Queue, Req = never>(
  queue: Q,
  propsOrProcess: MessagesProps | MessagesHandler<Req>,
  maybeProcess?: MessagesHandler<Req>,
): Effect.Effect<void, never, QueueEventSource> {
  const [props, process] =
    typeof propsOrProcess === "function"
      ? [{} as MessagesProps, propsOrProcess]
      : [propsOrProcess, maybeProcess!];
  return QueueEventSource.use((source) => source(queue, props, process));
}

/**
 * Event source connecting an SQS {@link Queue} to the hosting compute
 * (Lambda function or ServerHost process).
 *
 * The contract is a `Binding.Service`; the host-specific implementation
 * layers are `Lambda.QueueEventSource` (event-source mapping + runtime
 * dispatch) and `Server.SQSQueueEventSource` (long-poll receive loop).
 * Consume it through the {@link consumeQueueMessages} helper.
 * @binding
 * @section Consuming a Queue
 * @example Consume Messages in a Lambda Function
 * ```typescript
 * export default WorkerFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* SQS.Queue("Jobs");
 *
 *     // registers the event-source mapping and the runtime dispatcher
 *     yield* SQS.consumeQueueMessages(queue, { batchSize: 10 }, (records) =>
 *       records.pipe(
 *         Stream.runForEach((record) => Effect.log(record.body)),
 *       ),
 *     );
 *   }).pipe(Effect.provide(Lambda.QueueEventSource)),
 * );
 * ```
 */
export interface QueueEventSource extends Binding.Service<
  QueueEventSource,
  "AWS.SQS.QueueEventSource",
  QueueEventSourceService
> {}

export const QueueEventSource = Binding.Service<QueueEventSource>(
  "AWS.SQS.QueueEventSource",
);

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

export type QueueEventSourceService = <Req = never>(
  bucket: Queue,
  props: MessagesProps,
  process: (
    stream: Stream.Stream<SQSRecord>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;
