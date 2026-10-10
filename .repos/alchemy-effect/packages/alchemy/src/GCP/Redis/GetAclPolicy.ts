import type * as redis from "@distilled.cloud/gcp/redis_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AclPolicy } from "./AclPolicy.ts";

export interface GetAclPolicyRequest extends Omit<
  redis.GetProjectsLocationsAclPoliciesRequest,
  "name"
> {}

/**
 * Runtime binding for Memorystore Redis `aclPolicies.get`.
 *
 * Bind this operation to an {@link AclPolicy} in a Function/Action init
 * phase. Provide {@link GetAclPolicyHttp}.
 *
 * ### Observing ACL Policies
 * **Example:** Read the bound policy
 * ```typescript
 * const getAclPolicy = yield* GCP.Redis.GetAclPolicy(policy);
 * const live = yield* getAclPolicy();
 * ```
 *
 * @binding
 * @category Redis
 */
export interface GetAclPolicy extends Binding.Service<
  GetAclPolicy,
  "GCP.Redis.GetAclPolicy",
  (
    policy: AclPolicy,
  ) => Effect.Effect<
    (
      request?: GetAclPolicyRequest,
    ) => Effect.Effect<
      redis.AclPolicy,
      redis.GetProjectsLocationsAclPoliciesError,
      RuntimeContext
    >
  >
> {}

export const GetAclPolicy = Binding.Service<GetAclPolicy>(
  "GCP.Redis.GetAclPolicy",
);
