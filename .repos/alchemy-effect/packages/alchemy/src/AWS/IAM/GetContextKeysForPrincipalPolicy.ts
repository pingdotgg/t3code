import type * as iam from "@distilled.cloud/aws/iam";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `iam:GetContextKeysForPrincipalPolicy` — list the
 * condition context keys referenced by all policies attached to an existing
 * IAM user, group, or role, so a principal simulation can be primed with the
 * right `ContextEntries`.
 *
 * The principal (`PolicySourceArn`) is chosen per request, so the binding
 * takes no arguments and grants `iam:GetContextKeysForPrincipalPolicy` on
 * `*`. Provide the implementation with
 * `Effect.provide(AWS.IAM.GetContextKeysForPrincipalPolicyHttp)`.
 *
 * @binding
 * @section Simulating Policies
 * @example Discover a Role's Context Keys
 * ```typescript
 * // init
 * const getContextKeys = yield* IAM.GetContextKeysForPrincipalPolicy();
 *
 * // runtime
 * const { ContextKeyNames } = yield* getContextKeys({
 *   PolicySourceArn: roleArn,
 * });
 * ```
 */
export interface GetContextKeysForPrincipalPolicy extends Binding.Service<
  GetContextKeysForPrincipalPolicy,
  "AWS.IAM.GetContextKeysForPrincipalPolicy",
  () => Effect.Effect<
    (
      request: iam.GetContextKeysForPrincipalPolicyRequest,
    ) => Effect.Effect<
      iam.GetContextKeysForPolicyResponse,
      iam.GetContextKeysForPrincipalPolicyError
    >
  >
> {}
export const GetContextKeysForPrincipalPolicy =
  Binding.Service<GetContextKeysForPrincipalPolicy>(
    "AWS.IAM.GetContextKeysForPrincipalPolicy",
  );
