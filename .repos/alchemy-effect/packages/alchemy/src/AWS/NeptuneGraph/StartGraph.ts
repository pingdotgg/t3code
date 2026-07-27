import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for the `StartGraph` operation (IAM action `neptune-graph:StartGraph`),
 * scoped to one {@link Graph}.
 *
 * Restarts the bound graph after it was stopped — m-NCU billing resumes and the graph transitions back to `AVAILABLE`. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.StartGraphHttp)`.
 * @binding
 * @section Starting and Stopping a Graph
 * @example Start a stopped graph
 * ```typescript
 * const startGraph = yield* NeptuneGraph.StartGraph(graph);
 *
 * const result = yield* startGraph();
 * // result.status → transitioning toward AVAILABLE
 * ```
 */
export interface StartGraph extends Binding.Service<
  StartGraph,
  "AWS.NeptuneGraph.StartGraph",
  (
    graph: Graph,
  ) => Effect.Effect<
    () => Effect.Effect<
      neptunegraph.StartGraphOutput,
      neptunegraph.StartGraphError
    >
  >
> {}
export const StartGraph = Binding.Service<StartGraph>(
  "AWS.NeptuneGraph.StartGraph",
);
