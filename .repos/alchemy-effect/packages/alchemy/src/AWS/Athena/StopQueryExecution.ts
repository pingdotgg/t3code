import type * as athena from "@distilled.cloud/aws/athena";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WorkGroup } from "./WorkGroup.ts";

/**
 * Runtime binding for `athena:StopQueryExecution`.
 *
 * Cancels a running query in the bound workgroup. Stopping an already
 * finished query is a no-op, so the call is safely idempotent. Provide the
 * implementation with `Effect.provide(AWS.Athena.StopQueryExecutionHttp)`.
 * @binding
 * @section Cancelling Queries
 * @example Cancel a Runaway Query
 * ```typescript
 * // init — bind the operation to the workgroup
 * const stopQueryExecution = yield* AWS.Athena.StopQueryExecution(workGroup);
 *
 * // runtime
 * yield* stopQueryExecution({ QueryExecutionId: id });
 * ```
 */
export interface StopQueryExecution extends Binding.Service<
  StopQueryExecution,
  "AWS.Athena.StopQueryExecution",
  (
    workGroup: WorkGroup,
  ) => Effect.Effect<
    (
      request: athena.StopQueryExecutionInput,
    ) => Effect.Effect<
      athena.StopQueryExecutionOutput,
      athena.StopQueryExecutionError
    >
  >
> {}

export const StopQueryExecution = Binding.Service<StopQueryExecution>(
  "AWS.Athena.StopQueryExecution",
);
