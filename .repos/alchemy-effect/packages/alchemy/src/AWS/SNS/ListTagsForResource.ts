import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface ListTagsForResourceRequest extends Omit<
  sns.ListTagsForResourceRequest,
  "ResourceArn"
> {}

/**
 * Runtime binding for `sns:ListTagsForResource`.
 *
 * Bind this operation to a {@link Topic} inside a function runtime to read
 * the topic's tags; the `ResourceArn` is injected automatically. The binding
 * grants the host function `sns:ListTagsForResource` on the topic. Provide
 * the `ListTagsForResourceHttp` layer on the Function to implement the
 * binding.
 * @binding
 * @section Tagging Topics
 * @example List a Topic's Tags
 * ```typescript
 * // init (provide SNS.ListTagsForResourceHttp on the Function)
 * const listTagsForResource = yield* SNS.ListTagsForResource(topic);
 *
 * // runtime
 * const response = yield* listTagsForResource();
 * // response.Tags
 * ```
 */
export interface ListTagsForResource extends Binding.Service<
  ListTagsForResource,
  "AWS.SNS.ListTagsForResource",
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
> {}

export const ListTagsForResource = Binding.Service<ListTagsForResource>(
  "AWS.SNS.ListTagsForResource",
);
