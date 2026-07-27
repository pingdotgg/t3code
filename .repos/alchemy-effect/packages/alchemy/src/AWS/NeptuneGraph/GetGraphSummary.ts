import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for the `GetGraphSummary` operation (IAM action `neptune-graph:GetGraphSummary`),
 * scoped to one {@link Graph}.
 *
 * Reads the data summary of the bound graph — node/edge counts, labels, and (in `DETAILED` mode) per-label structure. Cheap way to sanity-check a load or drive dashboards without running a query. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.GetGraphSummaryHttp)`.
 * @binding
 * @section Inspecting a Graph
 * @example Read node and edge counts
 * ```typescript
 * const getSummary = yield* NeptuneGraph.GetGraphSummary(graph);
 *
 * const summary = yield* getSummary({ mode: "BASIC" });
 * // summary.graphSummary?.numNodes, summary.graphSummary?.numEdges
 * ```
 */
export interface GetGraphSummary extends Binding.Service<
  GetGraphSummary,
  "AWS.NeptuneGraph.GetGraphSummary",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request?: Omit<neptunegraph.GetGraphSummaryInput, "graphIdentifier">,
    ) => Effect.Effect<
      neptunegraph.GetGraphSummaryOutput,
      neptunegraph.GetGraphSummaryError
    >
  >
> {}
export const GetGraphSummary = Binding.Service<GetGraphSummary>(
  "AWS.NeptuneGraph.GetGraphSummary",
);
