import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetThirdPartyFirewallAssociationStatus}.
 */
export interface GetThirdPartyFirewallAssociationStatusRequest
  extends fms.GetThirdPartyFirewallAssociationStatusRequest {}

/**
 * Runtime binding for `fms:GetThirdPartyFirewallAssociationStatus`.
 *
 * Returns the onboarding status of the Firewall Manager admin account with a third-party firewall vendor tenant, including the AWS Marketplace
 * subscription status. Provide the implementation with `Effect.provide(AWS.FMS.GetThirdPartyFirewallAssociationStatusHttp)`.
 * @binding
 * @section Third-Party Firewalls
 * @example Check Third-Party Firewall Onboarding Status
 * ```typescript
 * // init — account-level binding takes no resource
 * const getThirdPartyFirewallAssociationStatus =
 *   yield* AWS.FMS.GetThirdPartyFirewallAssociationStatus();
 *
 * // runtime
 * const result = yield* getThirdPartyFirewallAssociationStatus({
 *   ThirdPartyFirewall: "PALO_ALTO_NETWORKS_CLOUD_NGFW",
 * });
 * console.log(
 *   result.ThirdPartyFirewallStatus,
 *   result.MarketplaceOnboardingStatus,
 * );
 * ```
 */
export interface GetThirdPartyFirewallAssociationStatus extends Binding.Service<
  GetThirdPartyFirewallAssociationStatus,
  "AWS.FMS.GetThirdPartyFirewallAssociationStatus",
  () => Effect.Effect<
    (
      request: GetThirdPartyFirewallAssociationStatusRequest,
    ) => Effect.Effect<
      fms.GetThirdPartyFirewallAssociationStatusResponse,
      fms.GetThirdPartyFirewallAssociationStatusError
    >
  >
> {}

export const GetThirdPartyFirewallAssociationStatus =
  Binding.Service<GetThirdPartyFirewallAssociationStatus>(
    "AWS.FMS.GetThirdPartyFirewallAssociationStatus",
  );
