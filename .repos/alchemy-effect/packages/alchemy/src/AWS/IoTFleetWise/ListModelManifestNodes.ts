import type * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ModelManifest } from "./ModelManifest.ts";

/**
 * `ListModelManifestNodes` request with `name` injected from the bound
 * model manifest.
 */
export interface ListModelManifestNodesRequest extends Omit<
  iotfleetwise.ListModelManifestNodesRequest,
  "name"
> {}

/**
 * Runtime binding for the `ListModelManifestNodes` operation (IAM action
 * `iotfleetwise:ListModelManifestNodes`), scoped to one
 * {@link ModelManifest}.
 *
 * Lists the signal nodes referenced by the bound vehicle model. Provide
 * the implementation with
 * `Effect.provide(AWS.IoTFleetWise.ListModelManifestNodesHttp)`.
 *
 * @binding
 * @section Inspecting Signal Definitions
 * @example List a Vehicle Model's Signals
 * ```typescript
 * const listModelManifestNodes =
 *   yield* IoTFleetWise.ListModelManifestNodes(model);
 *
 * const { nodes } = yield* listModelManifestNodes();
 * ```
 */
export interface ListModelManifestNodes extends Binding.Service<
  ListModelManifestNodes,
  "AWS.IoTFleetWise.ListModelManifestNodes",
  (
    model: ModelManifest,
  ) => Effect.Effect<
    (
      request?: ListModelManifestNodesRequest,
    ) => Effect.Effect<
      iotfleetwise.ListModelManifestNodesResponse,
      iotfleetwise.ListModelManifestNodesError
    >
  >
> {}
export const ListModelManifestNodes = Binding.Service<ListModelManifestNodes>(
  "AWS.IoTFleetWise.ListModelManifestNodes",
);
