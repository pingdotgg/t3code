import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for the `GetQuery` operation (IAM action `neptune-graph:GetQueryStatus`),
 * scoped to one {@link Graph}.
 *
 * Retrieves the status of a query running on the bound graph (IAM action `neptune-graph:GetQueryStatus`). Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.GetQueryHttp)`.
 * @binding
 * @section Managing Queries
 * @example Check a running query
 * ```typescript
 * const getQuery = yield* NeptuneGraph.GetQuery(graph);
 *
 * const status = yield* getQuery({ queryId });
 * // status.state → "RUNNING" | "WAITING" | "CANCELLING"
 * ```
 */
export interface GetQuery extends Binding.Service<
  GetQuery,
  "AWS.NeptuneGraph.GetQuery",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request: Omit<neptunegraph.GetQueryInput, "graphIdentifier">,
    ) => Effect.Effect<neptunegraph.GetQueryOutput, neptunegraph.GetQueryError>
  >
> {}
export const GetQuery = Binding.Service<GetQuery>("AWS.NeptuneGraph.GetQuery");
