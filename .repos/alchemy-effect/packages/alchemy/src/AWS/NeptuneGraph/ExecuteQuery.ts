import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

export interface ExecuteQueryRequest extends Omit<
  neptunegraph.ExecuteQueryInput,
  "graphIdentifier"
> {}

/**
 * Runtime binding for `neptune-graph:ExecuteQuery` — run an openCypher query
 * against a Neptune Analytics {@link Graph}.
 *
 * Bind this operation to a `Graph` inside a function runtime to get a
 * callable that automatically injects the graph identifier and grants the
 * data-plane query actions (`ReadDataViaQuery`, `WriteDataViaQuery`,
 * `DeleteDataViaQuery`) on the graph.
 *
 * The response `payload` is a streaming body — collect it to parse the JSON
 * result document.
 * @binding
 * @section Querying a Graph
 * @example Run an openCypher query
 * ```typescript
 * const executeQuery = yield* AWS.NeptuneGraph.ExecuteQuery(graph);
 *
 * const response = yield* executeQuery({
 *   queryString: "MATCH (n) RETURN count(n) AS nodes",
 *   language: "OPEN_CYPHER",
 * });
 * const body = yield* Stream.mkString(
 *   Stream.decodeText(response.payload),
 * );
 * const { results } = JSON.parse(body);
 * ```
 *
 * @example Write data with parameters
 * ```typescript
 * yield* executeQuery({
 *   queryString: "CREATE (n:Person {name: $name})",
 *   language: "OPEN_CYPHER",
 *   parameters: { name: "Ada" },
 * });
 * ```
 */
export interface ExecuteQuery extends Binding.Service<
  ExecuteQuery,
  "AWS.NeptuneGraph.ExecuteQuery",
  <G extends Graph>(
    graph: G,
  ) => Effect.Effect<
    (
      request: ExecuteQueryRequest,
    ) => Effect.Effect<
      neptunegraph.ExecuteQueryOutput,
      neptunegraph.ExecuteQueryError
    >
  >
> {}
export const ExecuteQuery = Binding.Service<ExecuteQuery>(
  "AWS.NeptuneGraph.ExecuteQuery",
);
