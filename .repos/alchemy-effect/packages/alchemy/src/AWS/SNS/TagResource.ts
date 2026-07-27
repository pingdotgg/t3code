import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface TagResourceRequest extends Omit<
  sns.TagResourceRequest,
  "ResourceArn"
> {}

/**
 * Runtime binding for `sns:TagResource`.
 *
 * Bind this operation to a {@link Topic} inside a function runtime to add or
 * overwrite tags on the topic; the `ResourceArn` is injected automatically.
 * The binding grants the host function `sns:TagResource` on the topic.
 * Provide the `TagResourceHttp` layer on the Function to implement the
 * binding.
 * @binding
 * @section Tagging Topics
 * @example Tag a Topic
 * ```typescript
 * // init (provide SNS.TagResourceHttp on the Function)
 * const tagResource = yield* SNS.TagResource(topic);
 *
 * // runtime
 * yield* tagResource({
 *   Tags: [{ Key: "team", Value: "orders" }],
 * });
 * ```
 */
export interface TagResource extends Binding.Service<
  TagResource,
  "AWS.SNS.TagResource",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: TagResourceRequest,
    ) => Effect.Effect<sns.TagResourceResponse, sns.TagResourceError>
  >
> {}

export const TagResource = Binding.Service<TagResource>("AWS.SNS.TagResource");
