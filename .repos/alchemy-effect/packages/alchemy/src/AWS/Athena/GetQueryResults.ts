import type * as athena from "@distilled.cloud/aws/athena";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WorkGroup } from "./WorkGroup.ts";

/**
 * Runtime binding for `athena:GetQueryResults`.
 *
 * Reads one page of a completed query's result set (raw rows + column
 * metadata) — use `NextToken`/`MaxResults` to paginate large results. For the
 * common run-and-decode flow, prefer the composite {@link Query} binding.
 * Provide the implementation with
 * `Effect.provide(AWS.Athena.GetQueryResultsHttp)`.
 * @binding
 * @section Reading Results
 * @example Page Through Query Results
 * ```typescript
 * // init — bind the operation to the workgroup
 * const getQueryResults = yield* AWS.Athena.GetQueryResults(workGroup);
 *
 * // runtime
 * const page = yield* getQueryResults({ QueryExecutionId: id, MaxResults: 100 });
 * console.log(page.ResultSet?.Rows?.length, page.NextToken);
 * ```
 */
export interface GetQueryResults extends Binding.Service<
  GetQueryResults,
  "AWS.Athena.GetQueryResults",
  (
    workGroup: WorkGroup,
  ) => Effect.Effect<
    (
      request: athena.GetQueryResultsInput,
    ) => Effect.Effect<
      athena.GetQueryResultsOutput,
      athena.GetQueryResultsError
    >
  >
> {}

export const GetQueryResults = Binding.Service<GetQueryResults>(
  "AWS.Athena.GetQueryResults",
);
