import type * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ManagedThing } from "./ManagedThing.ts";

/**
 * `ListManagedThingSchemas` request with `Identifier` injected from the
 * bound managed thing.
 */
export interface ListManagedThingSchemasRequest extends Omit<
  mi.ListManagedThingSchemasRequest,
  "Identifier"
> {}

/**
 * Runtime binding for the `ListManagedThingSchemas` operation (IAM action
 * `iotmanagedintegrations:ListManagedThingSchemas`), scoped to one
 * {@link ManagedThing}.
 *
 * Lists the capability schemas of the bound device, optionally filtered by
 * endpoint or capability id. Provide the implementation with
 * `Effect.provide(AWS.IoTManagedIntegrations.ListManagedThingSchemasHttp)`.
 *
 * @binding
 * @section Reading Device State
 * @example List Device Schemas
 * ```typescript
 * const listSchemas =
 *   yield* IoTManagedIntegrations.ListManagedThingSchemas(thing);
 *
 * const { Items } = yield* listSchemas({ EndpointIdFilter: "1" });
 * ```
 */
export interface ListManagedThingSchemas extends Binding.Service<
  ListManagedThingSchemas,
  "AWS.IoTManagedIntegrations.ListManagedThingSchemas",
  (
    thing: ManagedThing,
  ) => Effect.Effect<
    (
      request?: ListManagedThingSchemasRequest,
    ) => Effect.Effect<
      mi.ListManagedThingSchemasResponse,
      mi.ListManagedThingSchemasError
    >
  >
> {}
export const ListManagedThingSchemas = Binding.Service<ListManagedThingSchemas>(
  "AWS.IoTManagedIntegrations.ListManagedThingSchemas",
);
