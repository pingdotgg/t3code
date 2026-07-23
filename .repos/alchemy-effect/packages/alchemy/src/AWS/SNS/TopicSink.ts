import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import { PublishBatch } from "./PublishBatch.ts";
import type { Topic } from "./Topic.ts";

export class TopicSink extends Binding.Service<
  TopicSink,
  (
    topic: Topic,
  ) => Effect.Effect<Sink.Sink<void, string, readonly string[], never>>
>()("AWS.SNS.TopicSink") {}

export const TopicSinkLive = Layer.effect(
  TopicSink,
  Effect.gen(function* () {
    const Policy = yield* TopicSinkPolicy;
    const publishBatch = yield* PublishBatch;

    return Effect.fn(function* (topic: Topic) {
      yield* Policy(topic);
      const publish = yield* publishBatch(topic);

      return Sink.forEachArray((messages: readonly string[]) =>
        publish({
          PublishBatchRequestEntries: messages.map((message, index) => ({
            Id: `${index}`,
            Message: message,
          })),
        }).pipe(Effect.orDie, Effect.asVoid),
      );
    });
  }),
);

export class TopicSinkPolicy extends Binding.Policy<
  TopicSinkPolicy,
  (topic: Topic) => Effect.Effect<void>
>()("AWS.SNS.TopicSink") {}

export const TopicSinkPolicyLive = TopicSinkPolicy.layer.succeed(
  Effect.fn(function* (host, topic) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.SNS.TopicSink(${topic}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["sns:Publish"],
            Resource: [topic.topicArn],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `TopicSinkPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
