import type * as AVP from "@distilled.cloud/aws/verifiedpermissions";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PolicyStore } from "./PolicyStore.ts";

/**
 * A batch policy-retrieval request scoped to the bound policy store — the
 * store's `policyStoreId` is injected into every item.
 */
export interface GetPoliciesRequest {
  /**
   * Up to 100 policy IDs to retrieve from the bound policy store.
   */
  policyIds: string[];
}

/**
 * The runtime client returned by binding `GetPolicies` to a `PolicyStore`.
 */
export interface GetPoliciesClient {
  /**
   * Retrieve up to 100 policies from the bound store in one call
   * (`BatchGetPolicy`). Unknown IDs are reported in the output's `errors`
   * list rather than failing the call.
   */
  batchGetPolicy(
    request: GetPoliciesRequest,
  ): Effect.Effect<AVP.BatchGetPolicyOutput, AVP.BatchGetPolicyError>;
}

/**
 * Runtime binding for bulk policy retrieval — bind it to a `PolicyStore`
 * inside a function runtime to fetch policy definitions (e.g. for admin /
 * audit surfaces) without granting mutation rights.
 * @binding
 * @section Reading Policies at Runtime
 * @example Fetch Policies by ID
 * ```typescript
 * // init
 * const policies = yield* AWS.VerifiedPermissions.GetPolicies(store);
 *
 * // runtime
 * const { results, errors } = yield* policies.batchGetPolicy({
 *   policyIds: ["9wYixMplbbZQb5fcZHyJhY"],
 * });
 * ```
 */
export interface GetPolicies extends Binding.Service<
  GetPolicies,
  "AWS.VerifiedPermissions.GetPolicies",
  <S extends PolicyStore>(store: S) => Effect.Effect<GetPoliciesClient>
> {}
export const GetPolicies = Binding.Service<GetPolicies>(
  "AWS.VerifiedPermissions.GetPolicies",
);
