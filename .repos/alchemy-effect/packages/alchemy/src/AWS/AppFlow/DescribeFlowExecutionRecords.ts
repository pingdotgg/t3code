import type * as appflow from "@distilled.cloud/aws/appflow";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Flow } from "./Flow.ts";

export interface DescribeFlowExecutionRecordsRequest extends Omit<
  appflow.DescribeFlowExecutionRecordsRequest,
  "flowName"
> {}

/**
 * Runtime binding for `appflow:DescribeFlowExecutionRecords`.
 *
 * Bind this operation to a {@link Flow} in the function's init phase to get a
 * callable that pages through the flow's run history — each record carries
 * the `executionId`, status, timing, and record counts of one run. The flow
 * name is injected automatically and `appflow:DescribeFlowExecutionRecords`
 * is granted on the flow. Provide the implementation with
 * `Effect.provide(AWS.AppFlow.DescribeFlowExecutionRecordsHttp)`.
 * @binding
 * @section Monitoring Flow Runs
 * @example Check the Status of the Latest Run
 * ```typescript
 * // init — bind the operation to the flow
 * const describeFlowExecutionRecords =
 *   yield* AWS.AppFlow.DescribeFlowExecutionRecords(flow);
 *
 * // runtime — read the most recent run
 * const records = yield* describeFlowExecutionRecords({ maxResults: 1 });
 * const latest = records.flowExecutions?.[0];
 * // latest?.executionStatus === "Successful"
 * ```
 */
export interface DescribeFlowExecutionRecords extends Binding.Service<
  DescribeFlowExecutionRecords,
  "AWS.AppFlow.DescribeFlowExecutionRecords",
  (
    flow: Flow,
  ) => Effect.Effect<
    (
      request?: DescribeFlowExecutionRecordsRequest,
    ) => Effect.Effect<
      appflow.DescribeFlowExecutionRecordsResponse,
      appflow.DescribeFlowExecutionRecordsError
    >
  >
> {}

export const DescribeFlowExecutionRecords =
  Binding.Service<DescribeFlowExecutionRecords>(
    "AWS.AppFlow.DescribeFlowExecutionRecords",
  );
