import type * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SignalCatalog } from "./SignalCatalog.ts";

/**
 * `ListSignalCatalogNodes` request with `name` injected from the bound
 * signal catalog.
 */
export interface ListSignalCatalogNodesRequest extends Omit<
  iotfleetwise.ListSignalCatalogNodesRequest,
  "name"
> {}

/**
 * Runtime binding for the `ListSignalCatalogNodes` operation (IAM action
 * `iotfleetwise:ListSignalCatalogNodes`), scoped to one
 * {@link SignalCatalog}.
 *
 * Lists the branches, sensors, actuators, and attributes in the bound
 * signal catalog. Provide the implementation with
 * `Effect.provide(AWS.IoTFleetWise.ListSignalCatalogNodesHttp)`.
 *
 * @binding
 * @section Inspecting Signal Definitions
 * @example List the Catalog's Sensors
 * ```typescript
 * const listSignalCatalogNodes =
 *   yield* IoTFleetWise.ListSignalCatalogNodes(catalog);
 *
 * const { nodes } = yield* listSignalCatalogNodes({
 *   signalNodeType: "SENSOR",
 * });
 * ```
 */
export interface ListSignalCatalogNodes extends Binding.Service<
  ListSignalCatalogNodes,
  "AWS.IoTFleetWise.ListSignalCatalogNodes",
  (
    catalog: SignalCatalog,
  ) => Effect.Effect<
    (
      request?: ListSignalCatalogNodesRequest,
    ) => Effect.Effect<
      iotfleetwise.ListSignalCatalogNodesResponse,
      iotfleetwise.ListSignalCatalogNodesError
    >
  >
> {}
export const ListSignalCatalogNodes = Binding.Service<ListSignalCatalogNodes>(
  "AWS.IoTFleetWise.ListSignalCatalogNodes",
);
