import type * as athena from "@distilled.cloud/aws/athena";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WorkGroup } from "./WorkGroup.ts";

/**
 * Runtime binding for `athena:GetQueryExecution`.
 *
 * Reads the state, statistics, and configuration of a single query execution
 * that ran in the bound workgroup. Provide the implementation with
 * `Effect.provide(AWS.Athena.GetQueryExecutionHttp)`.
 * @binding
 * @section Inspecting Query Executions
 * @example Check a Query's State
 * ```typescript
 * // init — bind the operation to the workgroup
 * const getQueryExecution = yield* AWS.Athena.GetQueryExecution(workGroup);
 *
 * // runtime
 * const res = yield* getQueryExecution({ QueryExecutionId: id });
 * console.log(res.QueryExecution?.Status?.State);
 * ```
 */
export interface GetQueryExecution extends Binding.Service<
  GetQueryExecution,
  "AWS.Athena.GetQueryExecution",
  (
    workGroup: WorkGroup,
  ) => Effect.Effect<
    (
      request: athena.GetQueryExecutionInput,
    ) => Effect.Effect<
      athena.GetQueryExecutionOutput,
      athena.GetQueryExecutionError
    >
  >
> {}

export const GetQueryExecution = Binding.Service<GetQueryExecution>(
  "AWS.Athena.GetQueryExecution",
);
