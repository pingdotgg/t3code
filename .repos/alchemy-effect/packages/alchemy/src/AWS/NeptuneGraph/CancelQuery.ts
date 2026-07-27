import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for the `CancelQuery` operation (IAM action `neptune-graph:CancelQuery`),
 * scoped to one {@link Graph}.
 *
 * Cancels a query running on the bound graph by its query id — e.g. kill a runaway openCypher traversal found via {@link ListQueries}. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.CancelQueryHttp)`.
 * @binding
 * @section Managing Queries
 * @example Cancel a runaway query
 * ```typescript
 * const cancelQuery = yield* NeptuneGraph.CancelQuery(graph);
 *
 * yield* cancelQuery({ queryId });
 * ```
 */
export interface CancelQuery extends Binding.Service<
  CancelQuery,
  "AWS.NeptuneGraph.CancelQuery",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request: Omit<neptunegraph.CancelQueryInput, "graphIdentifier">,
    ) => Effect.Effect<
      neptunegraph.CancelQueryResponse,
      neptunegraph.CancelQueryError
    >
  >
> {}
export const CancelQuery = Binding.Service<CancelQuery>(
  "AWS.NeptuneGraph.CancelQuery",
);
