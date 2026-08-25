import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:UpdateOrganizationConfiguration`.
 *
 * Updates the Amazon Macie configuration settings for an organization in Organizations.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.UpdateOrganizationConfigurationHttp)`.
 * @binding
 * @section Organization & Members
 * @example Auto-Enable Macie for New Accounts
 * ```typescript
 * // init — account-level binding, no resource argument
 * const updateOrganizationConfiguration = yield* AWS.Macie2.UpdateOrganizationConfiguration();
 *
 * // runtime
 * yield* updateOrganizationConfiguration({ autoEnable: true });
 * ```
 */
export interface UpdateOrganizationConfiguration extends Binding.Service<
  UpdateOrganizationConfiguration,
  "AWS.Macie2.UpdateOrganizationConfiguration",
  () => Effect.Effect<
    (
      request?: macie2.UpdateOrganizationConfigurationRequest,
    ) => Effect.Effect<
      macie2.UpdateOrganizationConfigurationResponse,
      macie2.UpdateOrganizationConfigurationError
    >
  >
> {}
export const UpdateOrganizationConfiguration =
  Binding.Service<UpdateOrganizationConfiguration>(
    "AWS.Macie2.UpdateOrganizationConfiguration",
  );
