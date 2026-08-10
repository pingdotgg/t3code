import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface GetDataProtectionPolicyRequest extends Omit<
  sns.GetDataProtectionPolicyInput,
  "ResourceArn"
> {}

/**
 * Runtime binding for `sns:GetDataProtectionPolicy`.
 *
 * Bind this operation to a {@link Topic} inside a function runtime to read
 * the topic's data protection policy document; the `ResourceArn` is injected
 * automatically. The binding grants the host function
 * `sns:GetDataProtectionPolicy` on the topic. Provide the
 * `GetDataProtectionPolicyHttp` layer on the Function to implement the
 * binding.
 * @binding
 * @section Data Protection Policies
 * @example Read the Data Protection Policy
 * ```typescript
 * // init (provide SNS.GetDataProtectionPolicyHttp on the Function)
 * const getDataProtectionPolicy = yield* SNS.GetDataProtectionPolicy(topic);
 *
 * // runtime
 * const response = yield* getDataProtectionPolicy();
 * // response.DataProtectionPolicy (JSON document string)
 * ```
 */
export interface GetDataProtectionPolicy extends Binding.Service<
  GetDataProtectionPolicy,
  "AWS.SNS.GetDataProtectionPolicy",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request?: GetDataProtectionPolicyRequest,
    ) => Effect.Effect<
      sns.GetDataProtectionPolicyResponse,
      sns.GetDataProtectionPolicyError
    >
  >
> {}
export const GetDataProtectionPolicy = Binding.Service<GetDataProtectionPolicy>(
  "AWS.SNS.GetDataProtectionPolicy",
);
