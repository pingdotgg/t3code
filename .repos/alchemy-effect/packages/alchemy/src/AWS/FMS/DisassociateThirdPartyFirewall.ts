import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link DisassociateThirdPartyFirewall}.
 */
export interface DisassociateThirdPartyFirewallRequest
  extends fms.DisassociateThirdPartyFirewallRequest {}

/**
 * Runtime binding for `fms:DisassociateThirdPartyFirewall`.
 *
 * Disassociates a Firewall Manager policy administrator from a third-party firewall tenant. The third-party vendor deletes all of the firewalls
 * associated with the account. Provide the implementation with `Effect.provide(AWS.FMS.DisassociateThirdPartyFirewallHttp)`.
 * @binding
 * @section Third-Party Firewalls
 * @example Offboard a Third-Party Firewall Vendor
 * ```typescript
 * // init — account-level binding takes no resource
 * const disassociateThirdPartyFirewall = yield* AWS.FMS.DisassociateThirdPartyFirewall();
 *
 * // runtime
 * const result = yield* disassociateThirdPartyFirewall({
 *   ThirdPartyFirewall: "PALO_ALTO_NETWORKS_CLOUD_NGFW",
 * });
 * console.log(result.ThirdPartyFirewallStatus);
 * ```
 */
export interface DisassociateThirdPartyFirewall extends Binding.Service<
  DisassociateThirdPartyFirewall,
  "AWS.FMS.DisassociateThirdPartyFirewall",
  () => Effect.Effect<
    (
      request: DisassociateThirdPartyFirewallRequest,
    ) => Effect.Effect<
      fms.DisassociateThirdPartyFirewallResponse,
      fms.DisassociateThirdPartyFirewallError
    >
  >
> {}

export const DisassociateThirdPartyFirewall =
  Binding.Service<DisassociateThirdPartyFirewall>(
    "AWS.FMS.DisassociateThirdPartyFirewall",
  );
