import type * as athena from "@distilled.cloud/aws/athena";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "../S3/Bucket.ts";
import type { WorkGroup } from "./WorkGroup.ts";

/**
 * The query request — the workgroup is injected by the binding (which also
 * supplies the enforced result location), so callers pass the SQL text and any
 * execution context/parameters as the raw distilled shape.
 */
export interface RunQueryRequest extends Omit<
  athena.StartQueryExecutionInput,
  "WorkGroup" | "ResultConfiguration"
> {}

/**
 * The fully-resolved result of a query: the terminal state plus the decoded
 * result set (column names + rows of string cells, exactly as Athena returns
 * them — the first row of a `SELECT` is the header).
 */
export interface QueryResult {
  readonly queryExecutionId: string;
  readonly state: athena.QueryExecutionState;
  readonly stateChangeReason: string | undefined;
  readonly columns: string[];
  readonly rows: string[][];
}

/**
 * Raised when a query reaches a terminal non-`SUCCEEDED` state (FAILED or
 * CANCELLED), or does not settle within the bounded poll window.
 */
export class AthenaQueryFailed extends Data.TaggedError("AthenaQueryFailed")<{
  readonly queryExecutionId: string;
  readonly state: string;
  readonly reason: string | undefined;
}> {}

/**
 * Run an Athena query end-to-end from a Lambda/Task: start the execution
 * against a bound workgroup, poll `GetQueryExecution` until it reaches a
 * terminal state (bounded), then read and decode the result set. Results are
 * written to the workgroup's enforced S3 output location in `resultsBucket`.
 *
 * @binding
 * @section Running Queries
 * @example Query and read the result rows
 * ```typescript
 * const runQuery = yield* AWS.Athena.Query(workGroup, resultsBucket);
 * const result = yield* runQuery({ QueryString: "SELECT 1" });
 * // result.rows[0] === ["_col0"] (header), result.rows[1] === ["1"]
 * ```
 *
 * @example Bind a WorkGroup to a Lambda Function
 * ```typescript
 * import * as Athena from "alchemy/AWS/Athena";
 * import * as Lambda from "alchemy/AWS/Lambda";
 * import * as S3 from "alchemy/AWS/S3";
 * import * as Output from "alchemy/Output";
 *
 * export class QueryFunction extends Lambda.Function<Lambda.Function>()(
 *   "QueryFunction",
 * ) {}
 *
 * export default QueryFunction.make(
 *   { main: import.meta.url, url: true, timeout: Duration.seconds(60) },
 *   Effect.gen(function* () {
 *     const bucket = yield* S3.Bucket("Results", { forceDestroy: true });
 *     const workGroup = yield* Athena.WorkGroup("Analytics", {
 *       outputLocation: Output.interpolate`s3://${bucket.bucketName}/results/`,
 *       enforceWorkGroupConfiguration: true,
 *     });
 *
 *     // grants athena:StartQueryExecution/GetQueryExecution/GetQueryResults
 *     // on the workgroup, S3 access on the results bucket, and Glue catalog
 *     // reads for table-backed queries
 *     const runQuery = yield* Athena.Query(workGroup, bucket);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* runQuery({
 *           QueryString: "SELECT COUNT(*) AS c FROM my_db.people",
 *         });
 *         return yield* HttpServerResponse.json({ rows: result.rows });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Athena.QueryHttp)),
 * );
 * ```
 */
export interface Query extends Binding.Service<
  Query,
  "AWS.Athena.Query",
  (
    workGroup: WorkGroup,
    resultsBucket: Bucket,
  ) => Effect.Effect<
    (
      request: RunQueryRequest,
    ) => Effect.Effect<
      QueryResult,
      | athena.StartQueryExecutionError
      | athena.GetQueryExecutionError
      | athena.GetQueryResultsError
      | AthenaQueryFailed
    >
  >
> {}
export const Query = Binding.Service<Query>("AWS.Athena.Query");
