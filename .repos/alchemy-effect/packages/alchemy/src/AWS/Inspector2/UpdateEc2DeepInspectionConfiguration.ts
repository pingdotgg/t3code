import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:UpdateEc2DeepInspectionConfiguration`.
 *
 * Activates, deactivates Amazon Inspector deep inspection, or updates custom paths for your account.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.UpdateEc2DeepInspectionConfigurationHttp)`.
 * @binding
 * @section Account Settings & Usage
 * @example Activate Deep Inspection
 * ```typescript
 * // init
 * const updateEc2DeepInspectionConfiguration = yield* AWS.Inspector2.UpdateEc2DeepInspectionConfiguration();
 *
 * // runtime
 * const { status } = yield* updateEc2DeepInspectionConfiguration({ activateDeepInspection: true });
 * ```
 */
export interface UpdateEc2DeepInspectionConfiguration extends Binding.Service<
  UpdateEc2DeepInspectionConfiguration,
  "AWS.Inspector2.UpdateEc2DeepInspectionConfiguration",
  () => Effect.Effect<
    (
      request?: inspector2.UpdateEc2DeepInspectionConfigurationRequest,
    ) => Effect.Effect<
      inspector2.UpdateEc2DeepInspectionConfigurationResponse,
      inspector2.UpdateEc2DeepInspectionConfigurationError
    >
  >
> {}
export const UpdateEc2DeepInspectionConfiguration =
  Binding.Service<UpdateEc2DeepInspectionConfiguration>(
    "AWS.Inspector2.UpdateEc2DeepInspectionConfiguration",
  );
