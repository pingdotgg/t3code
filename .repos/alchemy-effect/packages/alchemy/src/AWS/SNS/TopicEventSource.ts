import type * as lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export type TopicNotification = lambda.SNSMessage;

export interface TopicEventSourceProps {
  /**
   * Raw SNS subscription attributes for the Lambda subscription, such as
   * `FilterPolicy` or `RedrivePolicy`.
   */
  attributes?: Record<string, string>;
}

/**
 * Event source connecting an SNS {@link Topic} to the hosting Lambda
 * function: it creates the `lambda`-protocol subscription (plus the invoke
 * permission) at deploy time and dispatches delivered notifications to the
 * registered handler at runtime.
 *
 * The contract is a `Binding.Service`; the Lambda implementation layer is
 * `Lambda.TopicEventSource`. Consume it through the
 * {@link consumeTopicNotifications} helper.
 * @binding
 * @section Consuming a Topic
 * @example Consume Notifications in a Lambda Function
 * ```typescript
 * export default WorkerFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const topic = yield* SNS.Topic("Events");
 *
 *     // registers the subscription and the runtime dispatcher
 *     yield* SNS.consumeTopicNotifications(topic, (stream) =>
 *       stream.pipe(
 *         Stream.runForEach((message) => Effect.log(message.Message)),
 *       ),
 *     );
 *   }).pipe(Effect.provide(Lambda.TopicEventSource)),
 * );
 * ```
 */
export interface TopicEventSource extends Binding.Service<
  TopicEventSource,
  "AWS.SNS.TopicEventSource",
  TopicEventSourceService
> {}
export const TopicEventSource = Binding.Service<TopicEventSource>(
  "AWS.SNS.TopicEventSource",
);

export type TopicEventSourceService = <StreamReq = never, Req = never>(
  topic: Topic,
  props: TopicEventSourceProps,
  process: (
    stream: Stream.Stream<TopicNotification, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

type TopicEventSourceHandler<Req, StreamReq> = (
  stream: Stream.Stream<TopicNotification, never, StreamReq>,
) => Effect.Effect<void, never, Req>;

/**
 * Subscribe a Lambda Function to an SNS {@link Topic}, processing published
 * notifications as a stream.
 *
 * @example
 * ```typescript
 * yield* consumeTopicNotifications(topic, (stream) =>
 *   stream.pipe(Stream.runForEach((message) => Effect.log(message.Message))),
 * );
 * ```
 *
 * @example With subscription attributes
 * ```typescript
 * yield* consumeTopicNotifications(
 *   topic,
 *   { attributes: { FilterPolicy: JSON.stringify({ type: ["order"] }) } },
 *   (stream) =>
 *     stream.pipe(Stream.runForEach((message) => Effect.log(message.Message))),
 * );
 * ```
 */
export function consumeTopicNotifications<
  T extends Topic,
  Req = never,
  StreamReq = never,
>(
  topic: T,
  process: TopicEventSourceHandler<Req, StreamReq>,
): Effect.Effect<void, never, TopicEventSource>;
export function consumeTopicNotifications<
  T extends Topic,
  Req = never,
  StreamReq = never,
>(
  topic: T,
  props: TopicEventSourceProps,
  process: TopicEventSourceHandler<Req, StreamReq>,
): Effect.Effect<void, never, TopicEventSource>;
export function consumeTopicNotifications<
  T extends Topic,
  Req = never,
  StreamReq = never,
>(
  topic: T,
  propsOrProcess:
    | TopicEventSourceProps
    | TopicEventSourceHandler<Req, StreamReq>,
  maybeProcess?: TopicEventSourceHandler<Req, StreamReq>,
) {
  const [props, process] =
    typeof propsOrProcess === "function"
      ? [{} as TopicEventSourceProps, propsOrProcess]
      : [propsOrProcess, maybeProcess!];
  return TopicEventSource.use((source) => source(topic, props, process));
}
