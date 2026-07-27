import type * as bcm from "@distilled.cloud/aws/bcm-data-exports";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Export } from "./Export.ts";

/**
 * Request for {@link GetExecution} — the bound export's ARN is injected
 * automatically.
 */
export interface GetExecutionRequest extends Omit<
  bcm.GetExecutionRequest,
  "ExportArn"
> {}

/**
 * Runtime binding for `bcm-data-exports:GetExecution`.
 *
 * Bind this operation to an {@link Export} to read the status of one export
 * execution (delivery run) — its status code, reason, and timestamps — from
 * inside a function runtime. Useful for delivery monitors that alert when a
 * refresh fails. Provide the implementation with
 * `Effect.provide(AWS.BCMDataExports.GetExecutionHttp)`.
 * @binding
 * @section Monitoring Executions
 * @example Check an Execution's Status
 * ```typescript
 * // init — bind the operation to the export
 * const getExecution = yield* AWS.BCMDataExports.GetExecution(cur);
 *
 * // runtime
 * const result = yield* getExecution({ ExecutionId: executionId });
 * const status = result.ExecutionStatus?.StatusCode;
 * ```
 */
export interface GetExecution extends Binding.Service<
  GetExecution,
  "AWS.BCMDataExports.GetExecution",
  (
    dataExport: Export,
  ) => Effect.Effect<
    (
      request: GetExecutionRequest,
    ) => Effect.Effect<bcm.GetExecutionResponse, bcm.GetExecutionError>
  >
> {}

export const GetExecution = Binding.Service<GetExecution>(
  "AWS.BCMDataExports.GetExecution",
);
