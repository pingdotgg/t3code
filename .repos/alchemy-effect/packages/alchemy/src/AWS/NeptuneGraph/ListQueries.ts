import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for the `ListQueries` operation (IAM action `neptune-graph:ListQueries`),
 * scoped to one {@link Graph}.
 *
 * Lists the openCypher queries currently active on the bound graph. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.ListQueriesHttp)`.
 * ### Managing Queries
 * **Example:** List active queries
 * ```typescript
 * const listQueries = yield* NeptuneGraph.ListQueries(graph);
 *
 * const { queries } = yield* listQueries({ maxResults: 100 });
 * ```
 *
 * @binding
 */
export interface ListQueries extends Binding.Service<
  ListQueries,
  "AWS.NeptuneGraph.ListQueries",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request: Omit<neptunegraph.ListQueriesInput, "graphIdentifier">,
    ) => Effect.Effect<
      neptunegraph.ListQueriesOutput,
      neptunegraph.ListQueriesError
    >
  >
> {}
export const ListQueries = Binding.Service<ListQueries>(
  "AWS.NeptuneGraph.ListQueries",
);
