import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:UpdateOrganizationConfiguration`.
 *
 * Updates how Security Hub is configured across the organization (auto-enable, central configuration).
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.UpdateOrganizationConfigurationHttp)`.
 * @binding
 * @section Members & Organization
 * @example Auto-Enable New Accounts
 * ```typescript
 * // init — account-level binding, no resource argument
 * const updateOrganizationConfiguration = yield* AWS.SecurityHub.UpdateOrganizationConfiguration();
 *
 * // runtime
 * yield* updateOrganizationConfiguration({ AutoEnable: true });
 * ```
 */
export interface UpdateOrganizationConfiguration extends Binding.Service<
  UpdateOrganizationConfiguration,
  "AWS.SecurityHub.UpdateOrganizationConfiguration",
  () => Effect.Effect<
    (
      request?: securityhub.UpdateOrganizationConfigurationRequest,
    ) => Effect.Effect<
      securityhub.UpdateOrganizationConfigurationResponse,
      securityhub.UpdateOrganizationConfigurationError
    >
  >
> {}
export const UpdateOrganizationConfiguration =
  Binding.Service<UpdateOrganizationConfiguration>(
    "AWS.SecurityHub.UpdateOrganizationConfiguration",
  );
