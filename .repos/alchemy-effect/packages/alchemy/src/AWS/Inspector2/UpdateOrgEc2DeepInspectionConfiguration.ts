import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:UpdateOrgEc2DeepInspectionConfiguration`.
 *
 * Updates the Amazon Inspector deep inspection custom paths for your organization. You must be an
 * Amazon Inspector delegated administrator to use this API.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.UpdateOrgEc2DeepInspectionConfigurationHttp)`.
 * @binding
 * @section Organization & Members
 * @example Set Org-Wide Deep Inspection Paths
 * ```typescript
 * // init
 * const updateOrgEc2DeepInspectionConfiguration = yield* AWS.Inspector2.UpdateOrgEc2DeepInspectionConfiguration();
 *
 * // runtime
 * yield* updateOrgEc2DeepInspectionConfiguration({ orgPackagePaths: ["/opt/app"] });
 * ```
 */
export interface UpdateOrgEc2DeepInspectionConfiguration extends Binding.Service<
  UpdateOrgEc2DeepInspectionConfiguration,
  "AWS.Inspector2.UpdateOrgEc2DeepInspectionConfiguration",
  () => Effect.Effect<
    (
      request: inspector2.UpdateOrgEc2DeepInspectionConfigurationRequest,
    ) => Effect.Effect<
      inspector2.UpdateOrgEc2DeepInspectionConfigurationResponse,
      inspector2.UpdateOrgEc2DeepInspectionConfigurationError
    >
  >
> {}
export const UpdateOrgEc2DeepInspectionConfiguration =
  Binding.Service<UpdateOrgEc2DeepInspectionConfiguration>(
    "AWS.Inspector2.UpdateOrgEc2DeepInspectionConfiguration",
  );
