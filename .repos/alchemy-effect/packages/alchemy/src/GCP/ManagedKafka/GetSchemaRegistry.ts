import type * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { SchemaRegistry } from "./SchemaRegistry.ts";

export interface GetSchemaRegistryRequest extends Omit<
  kafka.GetProjectsLocationsSchemaRegistriesRequest,
  "name"
> {}

/**
 * Runtime binding for Managed Kafka `schemaRegistries.get`.
 *
 * Bind this operation to a {@link SchemaRegistry} in a Function/Action
 * init phase. Provide {@link GetSchemaRegistryHttp}.
 *
 * Grants `roles/managedkafka.schemaRegistryViewer` (read-only) on the
 * project: schema-registry permission checks do not honor an IAM
 * Condition scoped to the registry's resource name.
 *
 * ### Observing Schema Registries
 * **Example:** Read the bound registry
 * ```typescript
 * const getRegistry = yield* GCP.ManagedKafka.GetSchemaRegistry(registry);
 * const live = yield* getRegistry();
 * ```
 *
 * @binding
 * @category ManagedKafka
 */
export interface GetSchemaRegistry extends Binding.Service<
  GetSchemaRegistry,
  "GCP.ManagedKafka.GetSchemaRegistry",
  (
    registry: SchemaRegistry,
  ) => Effect.Effect<
    (
      request?: GetSchemaRegistryRequest,
    ) => Effect.Effect<
      kafka.SchemaRegistry,
      kafka.GetProjectsLocationsSchemaRegistriesError,
      RuntimeContext
    >
  >
> {}

export const GetSchemaRegistry = Binding.Service<GetSchemaRegistry>(
  "GCP.ManagedKafka.GetSchemaRegistry",
);
