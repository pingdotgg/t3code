import type * as athena from "@distilled.cloud/aws/athena";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WorkGroup } from "./WorkGroup.ts";

/**
 * Runtime binding for `athena:GetQueryRuntimeStatistics`.
 *
 * Reads the runtime statistics (timeline, rows/bytes processed, stage tree)
 * of a query that ran in the bound workgroup. Provide the implementation with
 * `Effect.provide(AWS.Athena.GetQueryRuntimeStatisticsHttp)`.
 * @binding
 * @section Inspecting Query Executions
 * @example Read a Query's Runtime Statistics
 * ```typescript
 * // init — bind the operation to the workgroup
 * const getQueryRuntimeStatistics =
 *   yield* AWS.Athena.GetQueryRuntimeStatistics(workGroup);
 *
 * // runtime
 * const res = yield* getQueryRuntimeStatistics({ QueryExecutionId: id });
 * console.log(res.QueryRuntimeStatistics?.Timeline?.TotalExecutionTimeInMillis);
 * ```
 */
export interface GetQueryRuntimeStatistics extends Binding.Service<
  GetQueryRuntimeStatistics,
  "AWS.Athena.GetQueryRuntimeStatistics",
  (
    workGroup: WorkGroup,
  ) => Effect.Effect<
    (
      request: athena.GetQueryRuntimeStatisticsInput,
    ) => Effect.Effect<
      athena.GetQueryRuntimeStatisticsOutput,
      athena.GetQueryRuntimeStatisticsError
    >
  >
> {}

export const GetQueryRuntimeStatistics =
  Binding.Service<GetQueryRuntimeStatistics>(
    "AWS.Athena.GetQueryRuntimeStatistics",
  );
