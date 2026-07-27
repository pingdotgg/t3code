import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:DescribeEffectivePolicy`.
 *
 * Returns the contents of the effective policy of the specified type for an account — the aggregation of inherited plus directly attached management policies (tag, backup, AI-services opt-out, …).
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.DescribeEffectivePolicyHttp)`.
 * @binding
 * @section Policies & Effective Policy
 * @example Read an Account's Effective Tag Policy
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeEffectivePolicy = yield* AWS.Organizations.DescribeEffectivePolicy();
 *
 * // runtime
 * const { EffectivePolicy } = yield* describeEffectivePolicy({
 *   PolicyType: "TAG_POLICY",
 *   TargetId: accountId,
 * });
 * ```
 */
export interface DescribeEffectivePolicy extends Binding.Service<
  DescribeEffectivePolicy,
  "AWS.Organizations.DescribeEffectivePolicy",
  () => Effect.Effect<
    (
      request: organizations.DescribeEffectivePolicyRequest,
    ) => Effect.Effect<
      organizations.DescribeEffectivePolicyResponse,
      organizations.DescribeEffectivePolicyError
    >
  >
> {}
export const DescribeEffectivePolicy = Binding.Service<DescribeEffectivePolicy>(
  "AWS.Organizations.DescribeEffectivePolicy",
);
