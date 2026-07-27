import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for the `ResetGraph` operation (IAM action `neptune-graph:ResetGraph`),
 * scoped to one {@link Graph}.
 *
 * Empties all data from the bound graph while keeping the graph itself (and optionally snapshotting first) — e.g. refresh a demo or staging dataset before a re-import. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.ResetGraphHttp)`.
 * @binding
 * @section Resetting a Graph
 * @example Wipe all data from a graph
 * ```typescript
 * const resetGraph = yield* NeptuneGraph.ResetGraph(graph);
 *
 * yield* resetGraph({ skipSnapshot: true });
 * ```
 */
export interface ResetGraph extends Binding.Service<
  ResetGraph,
  "AWS.NeptuneGraph.ResetGraph",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request: Omit<neptunegraph.ResetGraphInput, "graphIdentifier">,
    ) => Effect.Effect<
      neptunegraph.ResetGraphOutput,
      neptunegraph.ResetGraphError
    >
  >
> {}
export const ResetGraph = Binding.Service<ResetGraph>(
  "AWS.NeptuneGraph.ResetGraph",
);
