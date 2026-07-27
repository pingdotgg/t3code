import type * as ram from "@distilled.cloud/aws/ram";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ram:GetResourcePolicies`.
 *
 * Retrieves the RAM-generated resource policies attached to resources that you own and have shared.
 * Account-level operation — the target shares, invitations, and permissions
 * are chosen per request at runtime, so the binding takes no resource
 * argument. Provide the implementation with
 * `Effect.provide(AWS.RAM.GetResourcePoliciesHttp)`.
 * @binding
 * @section Discovering Shares & Shared Resources
 * @example Read the Policy of a Shared Resource
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getResourcePolicies = yield* AWS.RAM.GetResourcePolicies();
 *
 * // runtime
 * const { policies } = yield* getResourcePolicies({
 *   resourceArns: [subnetArn],
 * });
 * ```
 */
export interface GetResourcePolicies extends Binding.Service<
  GetResourcePolicies,
  "AWS.RAM.GetResourcePolicies",
  () => Effect.Effect<
    (
      request: ram.GetResourcePoliciesRequest,
    ) => Effect.Effect<
      ram.GetResourcePoliciesResponse,
      ram.GetResourcePoliciesError
    >
  >
> {}
export const GetResourcePolicies = Binding.Service<GetResourcePolicies>(
  "AWS.RAM.GetResourcePolicies",
);
