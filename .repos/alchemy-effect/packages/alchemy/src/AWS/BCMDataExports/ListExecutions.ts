import type * as bcm from "@distilled.cloud/aws/bcm-data-exports";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Export } from "./Export.ts";

/**
 * Request for {@link ListExecutions} — the bound export's ARN is injected
 * automatically.
 */
export interface ListExecutionsRequest extends Omit<
  bcm.ListExecutionsRequest,
  "ExportArn"
> {}

/**
 * Runtime binding for `bcm-data-exports:ListExecutions`.
 *
 * Bind this operation to an {@link Export} to page through the export's
 * historical executions (delivery runs) from inside a function runtime.
 * Useful for delivery dashboards and monitors that scan for failed
 * refreshes. Provide the implementation with
 * `Effect.provide(AWS.BCMDataExports.ListExecutionsHttp)`.
 * @binding
 * @section Monitoring Executions
 * @example List Recent Executions
 * ```typescript
 * // init — bind the operation to the export
 * const listExecutions = yield* AWS.BCMDataExports.ListExecutions(cur);
 *
 * // runtime
 * const result = yield* listExecutions({ MaxResults: 25 });
 * const failed = (result.Executions ?? []).filter(
 *   (execution) =>
 *     execution.ExecutionStatus.StatusCode === "DELIVERY_FAILURE",
 * );
 * ```
 */
export interface ListExecutions extends Binding.Service<
  ListExecutions,
  "AWS.BCMDataExports.ListExecutions",
  (
    dataExport: Export,
  ) => Effect.Effect<
    (
      request?: ListExecutionsRequest,
    ) => Effect.Effect<bcm.ListExecutionsResponse, bcm.ListExecutionsError>
  >
> {}

export const ListExecutions = Binding.Service<ListExecutions>(
  "AWS.BCMDataExports.ListExecutions",
);
