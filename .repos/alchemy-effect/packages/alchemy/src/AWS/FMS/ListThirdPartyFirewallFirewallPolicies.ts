import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListThirdPartyFirewallFirewallPolicies}.
 */
export interface ListThirdPartyFirewallFirewallPoliciesRequest
  extends fms.ListThirdPartyFirewallFirewallPoliciesRequest {}

/**
 * Runtime binding for `fms:ListThirdPartyFirewallFirewallPolicies`.
 *
 * Retrieves a list of all of the third-party firewall policies that are associated with the third-party firewall administrator's account. Provide
 * the implementation with `Effect.provide(AWS.FMS.ListThirdPartyFirewallFirewallPoliciesHttp)`.
 * @binding
 * @section Third-Party Firewalls
 * @example List Third-Party Firewall Policies
 * ```typescript
 * // init — account-level binding takes no resource
 * const listThirdPartyFirewallFirewallPolicies =
 *   yield* AWS.FMS.ListThirdPartyFirewallFirewallPolicies();
 *
 * // runtime
 * const result = yield* listThirdPartyFirewallFirewallPolicies({
 *   ThirdPartyFirewall: "PALO_ALTO_NETWORKS_CLOUD_NGFW",
 *   MaxResults: 10,
 * });
 * console.log(result.ThirdPartyFirewallFirewallPolicies);
 * ```
 */
export interface ListThirdPartyFirewallFirewallPolicies extends Binding.Service<
  ListThirdPartyFirewallFirewallPolicies,
  "AWS.FMS.ListThirdPartyFirewallFirewallPolicies",
  () => Effect.Effect<
    (
      request: ListThirdPartyFirewallFirewallPoliciesRequest,
    ) => Effect.Effect<
      fms.ListThirdPartyFirewallFirewallPoliciesResponse,
      fms.ListThirdPartyFirewallFirewallPoliciesError
    >
  >
> {}

export const ListThirdPartyFirewallFirewallPolicies =
  Binding.Service<ListThirdPartyFirewallFirewallPolicies>(
    "AWS.FMS.ListThirdPartyFirewallFirewallPolicies",
  );
