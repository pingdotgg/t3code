import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:UpdateConfiguration`.
 *
 * Updates setting configurations for your Amazon Inspector account. When you use this API as an Amazon Inspector
 * delegated administrator this updates the setting for all accounts you manage. Member
 * accounts in an organization cannot update this setting.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.UpdateConfigurationHttp)`.
 * @binding
 * @section Account Settings & Usage
 * @example Tune ECR Rescan Duration
 * ```typescript
 * // init
 * const updateConfiguration = yield* AWS.Inspector2.UpdateConfiguration();
 *
 * // runtime
 * yield* updateConfiguration({
 *   ecrConfiguration: { rescanDuration: "DAYS_30" },
 * });
 * ```
 */
export interface UpdateConfiguration extends Binding.Service<
  UpdateConfiguration,
  "AWS.Inspector2.UpdateConfiguration",
  () => Effect.Effect<
    (
      request?: inspector2.UpdateConfigurationRequest,
    ) => Effect.Effect<
      inspector2.UpdateConfigurationResponse,
      inspector2.UpdateConfigurationError
    >
  >
> {}
export const UpdateConfiguration = Binding.Service<UpdateConfiguration>(
  "AWS.Inspector2.UpdateConfiguration",
);
