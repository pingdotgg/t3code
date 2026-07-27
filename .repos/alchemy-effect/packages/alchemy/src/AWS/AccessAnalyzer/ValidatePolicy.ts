import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `access-analyzer:ValidatePolicy`.
 *
 * Validates a policy document against IAM policy grammar and best practices,
 * returning findings with fix suggestions. Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.ValidatePolicyHttp)`.
 * @binding
 * @section Validating Policies
 * @example Validate an Identity Policy
 * ```typescript
 * // init — account-level, no resource argument
 * const validatePolicy = yield* AWS.AccessAnalyzer.ValidatePolicy();
 *
 * // runtime
 * const result = yield* validatePolicy({
 *   policyDocument: JSON.stringify(policy),
 *   policyType: "IDENTITY_POLICY",
 * });
 * ```
 */
export interface ValidatePolicy extends Binding.Service<
  ValidatePolicy,
  "AWS.AccessAnalyzer.ValidatePolicy",
  () => Effect.Effect<
    (
      request: aa.ValidatePolicyRequest,
    ) => Effect.Effect<aa.ValidatePolicyResponse, aa.ValidatePolicyError>
  >
> {}

export const ValidatePolicy = Binding.Service<ValidatePolicy>(
  "AWS.AccessAnalyzer.ValidatePolicy",
);
