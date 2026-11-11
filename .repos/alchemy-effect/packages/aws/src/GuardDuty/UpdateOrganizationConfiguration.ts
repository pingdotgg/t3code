import type * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:UpdateOrganizationConfiguration`.
 *
 * Updates the organization's GuardDuty auto-enable configuration (delegated administrator only).
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.UpdateOrganizationConfigurationHttp)`.
 * ### Organization Administration
 * **Example:** Auto-Enable New Accounts
 * ```typescript
 * // init
 * const updateOrganizationConfiguration = yield* AWS.GuardDuty.UpdateOrganizationConfiguration(detector);
 *
 * // runtime
 * yield* updateOrganizationConfiguration({
 *   AutoEnableOrganizationMembers: "NEW",
 * });
 * ```
 *
 * @binding
 */
export interface UpdateOrganizationConfiguration extends Binding.Service<
  UpdateOrganizationConfiguration,
  "AWS.GuardDuty.UpdateOrganizationConfiguration",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.UpdateOrganizationConfigurationRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.UpdateOrganizationConfigurationResponse,
      guardduty.UpdateOrganizationConfigurationError
    >
  >
> {}
export const UpdateOrganizationConfiguration = Binding.Service<UpdateOrganizationConfiguration>(
  "AWS.GuardDuty.UpdateOrganizationConfiguration",
);
