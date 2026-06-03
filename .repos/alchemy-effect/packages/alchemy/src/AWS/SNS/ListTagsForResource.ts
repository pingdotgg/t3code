import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Topic } from "./Topic.ts";

export interface ListTagsForResourceRequest extends Omit<
  sns.ListTagsForResourceRequest,
  "ResourceArn"
> {}

export class ListTagsForResource extends Binding.Service<
  ListTagsForResource,
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request?: ListTagsForResourceRequest,
    ) => Effect.Effect<
      sns.ListTagsForResourceResponse,
      sns.ListTagsForResourceError
    >
  >
>()("AWS.SNS.ListTagsForResource") {}

export const ListTagsForResourceLive = Layer.effect(
  ListTagsForResource,
  Effect.gen(function* () {
    const Policy = yield* ListTagsForResourcePolicy;
    const listTagsForResource = yield* sns.listTagsForResource;

    return Effect.fn(function* (topic: Topic) {
      const TopicArn = yield* topic.topicArn;
      yield* Policy(topic);
      return Effect.fn(function* (request?: ListTagsForResourceRequest) {
        return yield* listTagsForResource({
          ...request,
          ResourceArn: yield* TopicArn,
        });
      });
    });
  }),
);

export class ListTagsForResourcePolicy extends Binding.Policy<
  ListTagsForResourcePolicy,
  (topic: Topic) => Effect.Effect<void>
>()("AWS.SNS.ListTagsForResource") {}

export const ListTagsForResourcePolicyLive =
  ListTagsForResourcePolicy.layer.succeed(
    Effect.fn(function* (host, topic) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.SNS.ListTagsForResource(${topic}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sns:ListTagsForResource"],
                Resource: [topic.topicArn],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `ListTagsForResourcePolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
