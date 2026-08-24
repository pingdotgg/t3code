import type * as aoss from "@distilled.cloud/aws/opensearchserverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetPoliciesStats` operation (IAM action
 * `aoss:GetPoliciesStats`; the action does not support resource-level
 * scoping, so the grant is on `*`).
 *
 * Returns counts of the account's access policies, security policies,
 * security configurations, and lifecycle policies — useful for quota
 * dashboards (each policy type has an account quota). Provide the
 * implementation with
 * `Effect.provide(AWS.OpenSearchServerless.GetPoliciesStatsHttp)`.
 * @binding
 * @section Account Settings
 * @example Count the account's policies
 * ```typescript
 * const getPoliciesStats = yield* AWS.OpenSearchServerless.GetPoliciesStats();
 *
 * const stats = yield* getPoliciesStats();
 * yield* Effect.log(`total policies: ${stats.TotalPolicyCount}`);
 * ```
 */
export interface GetPoliciesStats extends Binding.Service<
  GetPoliciesStats,
  "AWS.OpenSearchServerless.GetPoliciesStats",
  () => Effect.Effect<
    (
      request?: aoss.GetPoliciesStatsRequest,
    ) => Effect.Effect<
      aoss.GetPoliciesStatsResponse,
      aoss.GetPoliciesStatsError
    >
  >
> {}
export const GetPoliciesStats = Binding.Service<GetPoliciesStats>(
  "AWS.OpenSearchServerless.GetPoliciesStats",
);
