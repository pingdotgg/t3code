import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:GetConfiguration`.
 *
 * Retrieves setting configurations for Inspector scans.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.GetConfigurationHttp)`.
 * ### Account Settings & Usage
 * **Example:** Read Scan Settings
 * ```typescript
 * // init
 * const getConfiguration = yield* AWS.Inspector2.GetConfiguration();
 *
 * // runtime
 * const { ecrConfiguration, ec2Configuration } = yield* getConfiguration();
 * ```
 *
 * @binding
 */
export interface GetConfiguration extends Binding.Service<
  GetConfiguration,
  "AWS.Inspector2.GetConfiguration",
  () => Effect.Effect<
    (
      request: inspector2.GetConfigurationRequest,
    ) => Effect.Effect<
      inspector2.GetConfigurationResponse,
      inspector2.GetConfigurationError
    >
  >
> {}
export const GetConfiguration = Binding.Service<GetConfiguration>(
  "AWS.Inspector2.GetConfiguration",
);
