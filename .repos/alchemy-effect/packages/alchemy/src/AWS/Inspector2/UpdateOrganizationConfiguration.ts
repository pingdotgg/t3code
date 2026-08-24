import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:UpdateOrganizationConfiguration`.
 *
 * Updates the configurations for your Amazon Inspector organization.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.UpdateOrganizationConfigurationHttp)`.
 * @binding
 * @section Organization & Members
 * @example Auto-Enable Scanning for New Members
 * ```typescript
 * // init
 * const updateOrganizationConfiguration = yield* AWS.Inspector2.UpdateOrganizationConfiguration();
 *
 * // runtime
 * yield* updateOrganizationConfiguration({
 *   autoEnable: { ec2: true, ecr: true, lambda: true },
 * });
 * ```
 */
export interface UpdateOrganizationConfiguration extends Binding.Service<
  UpdateOrganizationConfiguration,
  "AWS.Inspector2.UpdateOrganizationConfiguration",
  () => Effect.Effect<
    (
      request: inspector2.UpdateOrganizationConfigurationRequest,
    ) => Effect.Effect<
      inspector2.UpdateOrganizationConfigurationResponse,
      inspector2.UpdateOrganizationConfigurationError
    >
  >
> {}
export const UpdateOrganizationConfiguration =
  Binding.Service<UpdateOrganizationConfiguration>(
    "AWS.Inspector2.UpdateOrganizationConfiguration",
  );
