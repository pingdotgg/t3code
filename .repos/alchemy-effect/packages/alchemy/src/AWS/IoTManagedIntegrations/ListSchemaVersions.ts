import type * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListSchemaVersions}.
 */
export interface ListSchemaVersionsRequest
  extends mi.ListSchemaVersionsRequest {}

/**
 * Runtime binding for `iotmanagedintegrations:ListSchemaVersions`
 * (account-level).
 *
 * Lists capability or definition schema versions in the Managed
 * integrations schema catalog, optionally filtered by namespace, schema id,
 * visibility, or semantic version. Provide the implementation with
 * `Effect.provide(AWS.IoTManagedIntegrations.ListSchemaVersionsHttp)`.
 *
 * @binding
 * @section Working with the Schema Catalog
 * @example List Matter Capability Schemas
 * ```typescript
 * const listSchemaVersions = yield* IoTManagedIntegrations.ListSchemaVersions();
 *
 * const { Items } = yield* listSchemaVersions({
 *   Type: "capability",
 *   Namespace: "matter",
 * });
 * ```
 */
export interface ListSchemaVersions extends Binding.Service<
  ListSchemaVersions,
  "AWS.IoTManagedIntegrations.ListSchemaVersions",
  () => Effect.Effect<
    (
      request: ListSchemaVersionsRequest,
    ) => Effect.Effect<
      mi.ListSchemaVersionsResponse,
      mi.ListSchemaVersionsError
    >
  >
> {}
export const ListSchemaVersions = Binding.Service<ListSchemaVersions>(
  "AWS.IoTManagedIntegrations.ListSchemaVersions",
);
