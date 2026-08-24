import type * as dms from "@distilled.cloud/aws/database-migration-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dms:DescribeEndpointSettings`.
 *
 * Bind this operation (account-level) to enumerate the settings an endpoint
 * engine supports — names, types, enum values, defaults — e.g. to validate
 * user-supplied endpoint configuration before creating endpoints. Provide
 * the implementation with
 * `Effect.provide(AWS.DMS.DescribeEndpointSettingsHttp)`.
 * @binding
 * @section Inspecting Engine Settings
 * @example List the Settings MySQL Endpoints Accept
 * ```typescript
 * // init — account-level, no target resource
 * const endpointSettings = yield* AWS.DMS.DescribeEndpointSettings();
 *
 * // runtime
 * const { EndpointSettings } = yield* endpointSettings({
 *   EngineName: "mysql",
 * });
 * ```
 */
export interface DescribeEndpointSettings extends Binding.Service<
  DescribeEndpointSettings,
  "AWS.DMS.DescribeEndpointSettings",
  () => Effect.Effect<
    (
      request: dms.DescribeEndpointSettingsMessage,
    ) => Effect.Effect<
      dms.DescribeEndpointSettingsResponse,
      dms.DescribeEndpointSettingsError
    >
  >
> {}

export const DescribeEndpointSettings =
  Binding.Service<DescribeEndpointSettings>("AWS.DMS.DescribeEndpointSettings");
