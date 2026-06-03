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

export class TopicEventSource extends Binding.Service<
  TopicEventSource,
  TopicEventSourceService
>()("AWS.SNS.TopicEventSource") {}

export type TopicEventSourceService = <StreamReq = never, Req = never>(
  topic: Topic,
  props: TopicEventSourceProps,
  process: (
    stream: Stream.Stream<TopicNotification, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

export const notifications = <T extends Topic>(
  topic: T,
  props: TopicEventSourceProps = {},
) => ({
  subscribe: <Req = never, StreamReq = never>(
    process: (
      stream: Stream.Stream<TopicNotification, never, StreamReq>,
    ) => Effect.Effect<void, never, Req>,
  ) => TopicEventSource.use((source) => source(topic, props, process)),
});
