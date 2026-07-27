import type * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetSchemaVersion}.
 */
export interface GetSchemaVersionRequest extends mi.GetSchemaVersionRequest {}

/**
 * Runtime binding for `iotmanagedintegrations:GetSchemaVersion`
 * (account-level).
 *
 * Reads one version of a capability or definition schema from the Managed
 * integrations schema catalog — the vocabulary that device data models and
 * commands are expressed in. Provide the implementation with
 * `Effect.provide(AWS.IoTManagedIntegrations.GetSchemaVersionHttp)`.
 *
 * @binding
 * @section Working with the Schema Catalog
 * @example Fetch the On/Off Capability Schema
 * ```typescript
 * const getSchemaVersion = yield* IoTManagedIntegrations.GetSchemaVersion();
 *
 * const { Schema } = yield* getSchemaVersion({
 *   Type: "capability",
 *   SchemaVersionedId: "matter.OnOff@1.4",
 * });
 * ```
 */
export interface GetSchemaVersion extends Binding.Service<
  GetSchemaVersion,
  "AWS.IoTManagedIntegrations.GetSchemaVersion",
  () => Effect.Effect<
    (
      request: GetSchemaVersionRequest,
    ) => Effect.Effect<mi.GetSchemaVersionResponse, mi.GetSchemaVersionError>
  >
> {}
export const GetSchemaVersion = Binding.Service<GetSchemaVersion>(
  "AWS.IoTManagedIntegrations.GetSchemaVersion",
);
