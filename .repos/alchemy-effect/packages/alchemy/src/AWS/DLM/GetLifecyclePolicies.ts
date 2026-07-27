import type * as dlm from "@distilled.cloud/aws/dlm";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dlm:GetLifecyclePolicies`.
 *
 * Enumerates the account's Data Lifecycle Manager policies (optionally
 * filtered by state, resource type, or target tags) — the building block of
 * backup-coverage auditing: list every policy, flag the ones in `ERROR`, or
 * verify a fleet's tags are actually covered by an `ENABLED` policy.
 * Provide the implementation with
 * `Effect.provide(AWS.DLM.GetLifecyclePoliciesHttp)`.
 * @binding
 * @section Monitoring Lifecycle Policies
 * @example Find Failed Policies
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getLifecyclePolicies = yield* AWS.DLM.GetLifecyclePolicies();
 *
 * // runtime
 * const { Policies } = yield* getLifecyclePolicies({ State: "ERROR" });
 * for (const policy of Policies ?? []) {
 *   yield* Effect.logError(`DLM policy in ERROR: ${policy.PolicyId}`);
 * }
 * ```
 */
export interface GetLifecyclePolicies extends Binding.Service<
  GetLifecyclePolicies,
  "AWS.DLM.GetLifecyclePolicies",
  () => Effect.Effect<
    (
      request?: dlm.GetLifecyclePoliciesRequest,
    ) => Effect.Effect<
      dlm.GetLifecyclePoliciesResponse,
      dlm.GetLifecyclePoliciesError
    >
  >
> {}
export const GetLifecyclePolicies = Binding.Service<GetLifecyclePolicies>(
  "AWS.DLM.GetLifecyclePolicies",
);
