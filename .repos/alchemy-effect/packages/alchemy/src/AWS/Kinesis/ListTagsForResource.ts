import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Stream } from "./Stream.ts";
import type { StreamConsumer } from "./StreamConsumer.ts";

type TaggableResource = Stream | StreamConsumer;

export interface ListTagsForResourceRequest extends Omit<
  Kinesis.ListTagsForResourceInput,
  "ResourceARN"
> {}

export class ListTagsForResource extends Binding.Service<
  ListTagsForResource,
  (
    resource: TaggableResource,
  ) => Effect.Effect<
    (
      request?: ListTagsForResourceRequest,
    ) => Effect.Effect<
      Kinesis.ListTagsForResourceOutput,
      Kinesis.ListTagsForResourceError
    >
  >
>()("AWS.Kinesis.ListTagsForResource") {}

const getResourceArn = (resource: TaggableResource) =>
  "consumerArn" in resource ? resource.consumerArn : resource.streamArn;

export const ListTagsForResourceLive = Layer.effect(
  ListTagsForResource,
  Effect.gen(function* () {
    const Policy = yield* ListTagsForResourcePolicy;
    const listTagsForResource = yield* Kinesis.listTagsForResource;

    return Effect.fn(function* (resource: TaggableResource) {
      const ResourceARN = yield* getResourceArn(resource);
      yield* Policy(resource);
      return Effect.fn(function* (request?: ListTagsForResourceRequest) {
        return yield* listTagsForResource({
          ...request,
          ResourceARN: yield* ResourceARN,
        });
      });
    });
  }),
);

export class ListTagsForResourcePolicy extends Binding.Policy<
  ListTagsForResourcePolicy,
  (resource: TaggableResource) => Effect.Effect<void>
>()("AWS.Kinesis.ListTagsForResource") {}

export const ListTagsForResourcePolicyLive =
  ListTagsForResourcePolicy.layer.succeed(
    Effect.fn(function* (host, resource) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.Kinesis.ListTagsForResource(${resource}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["kinesis:ListTagsForResource"],
                Resource: [getResourceArn(resource)],
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
