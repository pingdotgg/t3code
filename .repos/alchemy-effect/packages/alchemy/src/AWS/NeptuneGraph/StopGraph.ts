import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for the `StopGraph` operation (IAM action `neptune-graph:StopGraph`),
 * scoped to one {@link Graph}.
 *
 * Stops the bound graph to pause compute (m-NCU) billing while retaining data — e.g. a scheduler Lambda parking dev graphs overnight. Restart with {@link StartGraph}. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.StopGraphHttp)`.
 * ### Starting and Stopping a Graph
 * **Example:** Stop a graph to pause billing
 * ```typescript
 * const stopGraph = yield* NeptuneGraph.StopGraph(graph);
 *
 * const result = yield* stopGraph();
 * // result.status → "STOPPING"
 * ```
 *
 * @binding
 */
export interface StopGraph extends Binding.Service<
  StopGraph,
  "AWS.NeptuneGraph.StopGraph",
  (
    graph: Graph,
  ) => Effect.Effect<
    () => Effect.Effect<
      neptunegraph.StopGraphOutput,
      neptunegraph.StopGraphError
    >
  >
> {}
export const StopGraph = Binding.Service<StopGraph>(
  "AWS.NeptuneGraph.StopGraph",
);
