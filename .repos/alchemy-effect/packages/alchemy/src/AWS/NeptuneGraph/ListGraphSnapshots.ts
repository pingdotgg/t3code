import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for the `ListGraphSnapshots` operation (IAM action `neptune-graph:ListGraphSnapshots`),
 * scoped to one {@link Graph}.
 *
 * Lists the snapshots of the bound graph. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.ListGraphSnapshotsHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example List a graph's snapshots
 * ```typescript
 * const listSnapshots = yield* NeptuneGraph.ListGraphSnapshots(graph);
 *
 * const { graphSnapshots } = yield* listSnapshots();
 * ```
 */
export interface ListGraphSnapshots extends Binding.Service<
  ListGraphSnapshots,
  "AWS.NeptuneGraph.ListGraphSnapshots",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request?: Omit<neptunegraph.ListGraphSnapshotsInput, "graphIdentifier">,
    ) => Effect.Effect<
      neptunegraph.ListGraphSnapshotsOutput,
      neptunegraph.ListGraphSnapshotsError
    >
  >
> {}
export const ListGraphSnapshots = Binding.Service<ListGraphSnapshots>(
  "AWS.NeptuneGraph.ListGraphSnapshots",
);
