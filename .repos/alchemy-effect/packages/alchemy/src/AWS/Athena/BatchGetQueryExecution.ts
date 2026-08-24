import type * as athena from "@distilled.cloud/aws/athena";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WorkGroup } from "./WorkGroup.ts";

/**
 * Runtime binding for `athena:BatchGetQueryExecution`.
 *
 * Reads up to 50 query executions from the bound workgroup in one call.
 * Provide the implementation with
 * `Effect.provide(AWS.Athena.BatchGetQueryExecutionHttp)`.
 * @binding
 * @section Inspecting Query Executions
 * @example Read Several Executions at Once
 * ```typescript
 * // init — bind the operation to the workgroup
 * const batchGetQueryExecution =
 *   yield* AWS.Athena.BatchGetQueryExecution(workGroup);
 *
 * // runtime
 * const res = yield* batchGetQueryExecution({ QueryExecutionIds: ids });
 * console.log(res.QueryExecutions?.map((qe) => qe.Status?.State));
 * ```
 */
export interface BatchGetQueryExecution extends Binding.Service<
  BatchGetQueryExecution,
  "AWS.Athena.BatchGetQueryExecution",
  (
    workGroup: WorkGroup,
  ) => Effect.Effect<
    (
      request: athena.BatchGetQueryExecutionInput,
    ) => Effect.Effect<
      athena.BatchGetQueryExecutionOutput,
      athena.BatchGetQueryExecutionError
    >
  >
> {}

export const BatchGetQueryExecution = Binding.Service<BatchGetQueryExecution>(
  "AWS.Athena.BatchGetQueryExecution",
);
