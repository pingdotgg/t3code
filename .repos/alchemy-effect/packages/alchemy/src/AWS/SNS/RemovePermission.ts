import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface RemovePermissionRequest extends Omit<
  sns.RemovePermissionInput,
  "TopicArn"
> {}

/**
 * Runtime binding for `sns:RemovePermission`.
 *
 * Bind this operation to a {@link Topic} inside a function runtime to remove
 * a policy statement previously added with {@link AddPermission} by its
 * label. The binding grants the host function `sns:RemovePermission` on the
 * topic. Provide the `RemovePermissionHttp` layer on the Function to
 * implement the binding.
 * @binding
 * @section Managing Topic Permissions
 * @example Remove a Permission by Label
 * ```typescript
 * // init (provide SNS.RemovePermissionHttp on the Function)
 * const removePermission = yield* SNS.RemovePermission(topic);
 *
 * // runtime
 * yield* removePermission({ Label: "PartnerPublish" });
 * ```
 */
export interface RemovePermission extends Binding.Service<
  RemovePermission,
  "AWS.SNS.RemovePermission",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: RemovePermissionRequest,
    ) => Effect.Effect<sns.RemovePermissionResponse, sns.RemovePermissionError>
  >
> {}

export const RemovePermission = Binding.Service<RemovePermission>(
  "AWS.SNS.RemovePermission",
);
