import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:GetEc2DeepInspectionConfiguration`.
 *
 * Retrieves the activation status of Amazon Inspector deep inspection and custom paths associated
 * with your account.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.GetEc2DeepInspectionConfigurationHttp)`.
 * @binding
 * @section Account Settings & Usage
 * @example Read Deep Inspection Settings
 * ```typescript
 * // init
 * const getEc2DeepInspectionConfiguration = yield* AWS.Inspector2.GetEc2DeepInspectionConfiguration();
 *
 * // runtime
 * const { status, packagePaths } = yield* getEc2DeepInspectionConfiguration();
 * ```
 */
export interface GetEc2DeepInspectionConfiguration extends Binding.Service<
  GetEc2DeepInspectionConfiguration,
  "AWS.Inspector2.GetEc2DeepInspectionConfiguration",
  () => Effect.Effect<
    (
      request: inspector2.GetEc2DeepInspectionConfigurationRequest,
    ) => Effect.Effect<
      inspector2.GetEc2DeepInspectionConfigurationResponse,
      inspector2.GetEc2DeepInspectionConfigurationError
    >
  >
> {}
export const GetEc2DeepInspectionConfiguration =
  Binding.Service<GetEc2DeepInspectionConfiguration>(
    "AWS.Inspector2.GetEc2DeepInspectionConfiguration",
  );
