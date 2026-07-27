import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link AssociateThirdPartyFirewall}.
 */
export interface AssociateThirdPartyFirewallRequest
  extends fms.AssociateThirdPartyFirewallRequest {}

/**
 * Runtime binding for `fms:AssociateThirdPartyFirewall`.
 *
 * Sets the Firewall Manager policy administrator as a tenant administrator of a third-party firewall service (Palo Alto Networks Cloud NGFW or
 * Fortigate Cloud Native Firewall). Requires an active AWS Marketplace subscription to the vendor. Provide the implementation with
 * `Effect.provide(AWS.FMS.AssociateThirdPartyFirewallHttp)`.
 * @binding
 * @section Third-Party Firewalls
 * @example Onboard a Third-Party Firewall Vendor
 * ```typescript
 * // init — account-level binding takes no resource
 * const associateThirdPartyFirewall = yield* AWS.FMS.AssociateThirdPartyFirewall();
 *
 * // runtime
 * const result = yield* associateThirdPartyFirewall({
 *   ThirdPartyFirewall: "PALO_ALTO_NETWORKS_CLOUD_NGFW",
 * });
 * console.log(result.ThirdPartyFirewallStatus);
 * ```
 */
export interface AssociateThirdPartyFirewall extends Binding.Service<
  AssociateThirdPartyFirewall,
  "AWS.FMS.AssociateThirdPartyFirewall",
  () => Effect.Effect<
    (
      request: AssociateThirdPartyFirewallRequest,
    ) => Effect.Effect<
      fms.AssociateThirdPartyFirewallResponse,
      fms.AssociateThirdPartyFirewallError
    >
  >
> {}

export const AssociateThirdPartyFirewall =
  Binding.Service<AssociateThirdPartyFirewall>(
    "AWS.FMS.AssociateThirdPartyFirewall",
  );
