import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface AddPermissionRequest extends Omit<
  sns.AddPermissionInput,
  "TopicArn"
> {}

/**
 * Runtime binding for `sns:AddPermission`.
 *
 * Bind this operation to a {@link Topic} inside a function runtime to grant
 * other AWS accounts access to topic actions by adding a labeled statement
 * to the topic's access policy. The binding grants the host function
 * `sns:AddPermission` on the topic. Provide the `AddPermissionHttp` layer on
 * the Function to implement the binding.
 * @binding
 * @section Managing Topic Permissions
 * @example Allow Another Account to Publish
 * ```typescript
 * // init (provide SNS.AddPermissionHttp on the Function)
 * const addPermission = yield* SNS.AddPermission(topic);
 *
 * // runtime
 * yield* addPermission({
 *   Label: "PartnerPublish",
 *   AWSAccountId: ["123456789012"],
 *   ActionName: ["Publish"],
 * });
 * ```
 */
export interface AddPermission extends Binding.Service<
  AddPermission,
  "AWS.SNS.AddPermission",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: AddPermissionRequest,
    ) => Effect.Effect<sns.AddPermissionResponse, sns.AddPermissionError>
  >
> {}

export const AddPermission = Binding.Service<AddPermission>(
  "AWS.SNS.AddPermission",
);
