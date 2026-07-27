import type * as iam from "@distilled.cloud/aws/iam";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `iam:GetContextKeysForCustomPolicy` — list the condition
 * context keys (`aws:username`, `aws:SourceIp`, …) referenced by a set of
 * candidate policy documents, so a simulation can be primed with the right
 * `ContextEntries`.
 *
 * The policies are supplied as strings per request, so the binding takes no
 * arguments and grants `iam:GetContextKeysForCustomPolicy` on `*`. Provide the
 * implementation with `Effect.provide(AWS.IAM.GetContextKeysForCustomPolicyHttp)`.
 *
 * @binding
 * @section Simulating Policies
 * @example Discover a Policy's Context Keys
 * ```typescript
 * // init
 * const getContextKeys = yield* IAM.GetContextKeysForCustomPolicy();
 *
 * // runtime
 * const { ContextKeyNames } = yield* getContextKeys({
 *   PolicyInputList: [policyJson],
 * });
 * ```
 */
export interface GetContextKeysForCustomPolicy extends Binding.Service<
  GetContextKeysForCustomPolicy,
  "AWS.IAM.GetContextKeysForCustomPolicy",
  () => Effect.Effect<
    (
      request: iam.GetContextKeysForCustomPolicyRequest,
    ) => Effect.Effect<
      iam.GetContextKeysForPolicyResponse,
      iam.GetContextKeysForCustomPolicyError
    >
  >
> {}
export const GetContextKeysForCustomPolicy =
  Binding.Service<GetContextKeysForCustomPolicy>(
    "AWS.IAM.GetContextKeysForCustomPolicy",
  );
