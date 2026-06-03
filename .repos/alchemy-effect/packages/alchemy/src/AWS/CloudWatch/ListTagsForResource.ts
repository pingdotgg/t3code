import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import {
  getTaggableResourceArn,
  type TaggableResource,
} from "./binding-common.ts";

export interface ListTagsForResourceRequest extends Omit<
  cloudwatch.ListTagsForResourceInput,
  "ResourceARN"
> {}

/**
 * Runtime binding for `cloudwatch:ListTagsForResource`.
 */
export class ListTagsForResource extends Binding.Service<
  ListTagsForResource,
  (
    resource: TaggableResource,
  ) => Effect.Effect<
    (
      request?: ListTagsForResourceRequest,
    ) => Effect.Effect<
      cloudwatch.ListTagsForResourceOutput,
      cloudwatch.ListTagsForResourceError
    >
  >
>()("AWS.CloudWatch.ListTagsForResource") {}

export const ListTagsForResourceLive = Layer.effect(
  ListTagsForResource,
  Effect.gen(function* () {
    const Policy = yield* ListTagsForResourcePolicy;
    const listTagsForResource = yield* cloudwatch.listTagsForResource;

    return Effect.fn(function* (resource: TaggableResource) {
      const ResourceARN = yield* getTaggableResourceArn(resource);
      yield* Policy(resource);

      return Effect.fn(function* (request: ListTagsForResourceRequest = {}) {
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
>()("AWS.CloudWatch.ListTagsForResource") {}

export const ListTagsForResourcePolicyLive =
  ListTagsForResourcePolicy.layer.succeed(
    Effect.fn(function* (host, resource) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.CloudWatch.ListTagsForResource(${resource}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["cloudwatch:ListTagsForResource"],
                Resource: [getTaggableResourceArn(resource)],
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
