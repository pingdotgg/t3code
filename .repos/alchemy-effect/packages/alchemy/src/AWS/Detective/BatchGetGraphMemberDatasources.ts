import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for `detective:BatchGetGraphMemberDatasources`.
 *
 * Reads per-member data source ingest history for the behavior graph —
 * which packages each member account is contributing and when their ingest
 * state last changed. The graph ARN is injected from the bound {@link Graph}.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.BatchGetGraphMemberDatasourcesHttp)`.
 * @binding
 * @section Managing Data Source Packages
 * @example Inspect Member Ingest History
 * ```typescript
 * // init
 * const batchGetGraphMemberDatasources =
 *   yield* AWS.Detective.BatchGetGraphMemberDatasources(graph);
 *
 * // runtime
 * const { MemberDatasources } = yield* batchGetGraphMemberDatasources({
 *   AccountIds: ["111122223333"],
 * });
 * ```
 */
export interface BatchGetGraphMemberDatasources extends Binding.Service<
  BatchGetGraphMemberDatasources,
  "AWS.Detective.BatchGetGraphMemberDatasources",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request: Omit<
        detective.BatchGetGraphMemberDatasourcesRequest,
        "GraphArn"
      >,
    ) => Effect.Effect<
      detective.BatchGetGraphMemberDatasourcesResponse,
      detective.BatchGetGraphMemberDatasourcesError
    >
  >
> {}
export const BatchGetGraphMemberDatasources =
  Binding.Service<BatchGetGraphMemberDatasources>(
    "AWS.Detective.BatchGetGraphMemberDatasources",
  );
