import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface UntagResourceRequest extends Omit<
  sns.UntagResourceRequest,
  "ResourceArn"
> {}

/**
 * Runtime binding for `sns:UntagResource`.
 *
 * Bind this operation to a {@link Topic} inside a function runtime to remove
 * tags from the topic by key; the `ResourceArn` is injected automatically.
 * The binding grants the host function `sns:UntagResource` on the topic.
 * Provide the `UntagResourceHttp` layer on the Function to implement the
 * binding.
 * @binding
 * @section Tagging Topics
 * @example Remove Tags from a Topic
 * ```typescript
 * // init (provide SNS.UntagResourceHttp on the Function)
 * const untagResource = yield* SNS.UntagResource(topic);
 *
 * // runtime
 * yield* untagResource({ TagKeys: ["team"] });
 * ```
 */
export interface UntagResource extends Binding.Service<
  UntagResource,
  "AWS.SNS.UntagResource",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: UntagResourceRequest,
    ) => Effect.Effect<sns.UntagResourceResponse, sns.UntagResourceError>
  >
> {}
export const UntagResource = Binding.Service<UntagResource>(
  "AWS.SNS.UntagResource",
);
