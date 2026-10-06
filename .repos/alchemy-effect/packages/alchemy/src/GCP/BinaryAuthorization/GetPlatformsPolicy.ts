import type * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { PlatformsPolicy } from "./PlatformsPolicy.ts";

export interface GetPlatformsPolicyRequest extends Omit<
  binaryauthorization.GetProjectsPlatformsPoliciesRequest,
  "name"
> {}

/**
 * Runtime binding for Binary Authorization `platforms.policies.get`.
 *
 * Bind this operation to a {@link PlatformsPolicy} in a Function/Action
 * init phase. Provide {@link GetPlatformsPolicyHttp}.
 *
 * ### Reading a Platform Policy
 * **Example:** Get the bound policy
 * ```typescript
 * const getPolicy = yield* GCP.BinaryAuthorization.GetPlatformsPolicy(
 *   policy,
 * );
 * const live = yield* getPolicy();
 * ```
 *
 * @binding
 * @category BinaryAuthorization
 */
export interface GetPlatformsPolicy extends Binding.Service<
  GetPlatformsPolicy,
  "GCP.BinaryAuthorization.GetPlatformsPolicy",
  (
    policy: PlatformsPolicy,
  ) => Effect.Effect<
    (
      request?: GetPlatformsPolicyRequest,
    ) => Effect.Effect<
      binaryauthorization.PlatformPolicy,
      binaryauthorization.GetProjectsPlatformsPoliciesError,
      RuntimeContext
    >
  >
> {}

export const GetPlatformsPolicy = Binding.Service<GetPlatformsPolicy>(
  "GCP.BinaryAuthorization.GetPlatformsPolicy",
);
