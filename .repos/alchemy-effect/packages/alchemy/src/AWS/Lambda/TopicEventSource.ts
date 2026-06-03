import type lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import { Subscription as SNSSubscription } from "../SNS/Subscription.ts";
import type { Topic } from "../SNS/Topic.ts";
import {
  TopicEventSource as SNSTopicEventSource,
  type TopicEventSourceProps,
  type TopicEventSourceService,
  type TopicNotification,
} from "../SNS/TopicEventSource.ts";
import * as Lambda from "./Function.ts";
import { Permission as LambdaPermission } from "./Permission.ts";

export const isSNSEvent = (event: any): event is lambda.SNSEvent =>
  Array.isArray(event?.Records) &&
  event.Records.some((record: any) => record.EventSource === "aws:sns");

export const TopicEventSource = Layer.effect(
  SNSTopicEventSource,
  Effect.gen(function* () {
    const host = yield* Lambda.Function;
    const bind = yield* TopicEventSourcePolicy;

    return Effect.fn(function* <StreamReq = never, Req = never>(
      topic: Topic,
      props: TopicEventSourceProps,
      process: (
        stream: Stream.Stream<TopicNotification, never, StreamReq>,
      ) => Effect.Effect<void, never, Req>,
    ) {
      const TopicArn = yield* topic.topicArn;

      yield* bind(topic, props);

      yield* host.listen(
        Effect.gen(function* () {
          const topicArn = yield* TopicArn;

          return (event: any) => {
            if (isSNSEvent(event)) {
              const records = event.Records.filter(
                (record) => record.Sns?.TopicArn === topicArn,
              );

              if (records.length > 0) {
                return process(
                  Stream.fromArray(
                    records.map((record) => record.Sns as TopicNotification),
                  ),
                ).pipe(Effect.orDie);
              }
            }
          };
        }),
      );
    }) as TopicEventSourceService;
  }),
);

export class TopicEventSourcePolicy extends Binding.Policy<
  TopicEventSourcePolicy,
  (topic: Topic, props?: TopicEventSourceProps) => Effect.Effect<void>
>()("AWS.SNS.TopicEventSource") {}

export const TopicEventSourcePolicyLive = TopicEventSourcePolicy.layer.effect(
  Effect.gen(function* () {
    const Permission = yield* LambdaPermission;
    const Subscription = yield* SNSSubscription;

    return Effect.fn(function* (
      host,
      topic,
      props: TopicEventSourceProps = {},
    ) {
      if (Lambda.isFunction(host)) {
        yield* Permission(`AWS.Lambda.InvokeFunction(${topic.LogicalId})`, {
          action: "lambda:InvokeFunction",
          functionName: host.functionName,
          principal: "sns.amazonaws.com",
          sourceArn: topic.topicArn,
        });

        yield* Subscription(
          `AWS.SNS.Subscription(${topic.LogicalId}, ${host.LogicalId})`,
          {
            topicArn: topic.topicArn,
            protocol: "lambda",
            endpoint: host.functionArn,
            attributes: props.attributes,
            returnSubscriptionArn: true,
          },
        );
      } else {
        return yield* Effect.die(
          new Error(
            `TopicEventSourcePolicy does not support runtime '${host.Type}'`,
          ),
        );
      }
    });
  }),
);
