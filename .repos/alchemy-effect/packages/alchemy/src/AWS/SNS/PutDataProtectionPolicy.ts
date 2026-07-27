import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export interface PutDataProtectionPolicyRequest extends Omit<
  sns.PutDataProtectionPolicyInput,
  "ResourceArn"
> {}

/**
 * Runtime binding for `sns:PutDataProtectionPolicy`.
 *
 * Bind this operation to a {@link Topic} inside a function runtime to attach
 * or replace the topic's data protection policy; the `ResourceArn` is
 * injected automatically. The binding grants the host function
 * `sns:PutDataProtectionPolicy` on the topic. Provide the
 * `PutDataProtectionPolicyHttp` layer on the Function to implement the
 * binding.
 * @binding
 * @section Data Protection Policies
 * @example Attach a Data Protection Policy
 * ```typescript
 * // init (provide SNS.PutDataProtectionPolicyHttp on the Function)
 * const putDataProtectionPolicy = yield* SNS.PutDataProtectionPolicy(topic);
 *
 * // runtime
 * yield* putDataProtectionPolicy({
 *   DataProtectionPolicy: JSON.stringify({
 *     Name: "basic-pii-audit",
 *     Version: "2021-06-01",
 *     Statement: [],
 *   }),
 * });
 * ```
 */
export interface PutDataProtectionPolicy extends Binding.Service<
  PutDataProtectionPolicy,
  "AWS.SNS.PutDataProtectionPolicy",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: PutDataProtectionPolicyRequest,
    ) => Effect.Effect<
      sns.PutDataProtectionPolicyResponse,
      sns.PutDataProtectionPolicyError
    >
  >
> {}
export const PutDataProtectionPolicy = Binding.Service<PutDataProtectionPolicy>(
  "AWS.SNS.PutDataProtectionPolicy",
);
