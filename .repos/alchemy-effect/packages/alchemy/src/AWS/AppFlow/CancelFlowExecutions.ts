import type * as appflow from "@distilled.cloud/aws/appflow";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Flow } from "./Flow.ts";

export interface CancelFlowExecutionsRequest extends Omit<
  appflow.CancelFlowExecutionsRequest,
  "flowName"
> {}

/**
 * Runtime binding for `appflow:CancelFlowExecutions`.
 *
 * Bind this operation to a {@link Flow} in the function's init phase to get a
 * callable that cancels in-progress runs of the flow — all active runs when
 * called with no arguments, or only the given `executionIds`. Executions that
 * cannot be canceled (already finished, unknown) are returned in
 * `invalidExecutions`. The flow name is injected automatically and
 * `appflow:CancelFlowExecutions` is granted on the flow. Provide the
 * implementation with `Effect.provide(AWS.AppFlow.CancelFlowExecutionsHttp)`.
 * @binding
 * @section Running Flows
 * @example Cancel Specific Flow Runs
 * ```typescript
 * // init — bind the operation to the flow
 * const cancelFlowExecutions = yield* AWS.AppFlow.CancelFlowExecutions(flow);
 *
 * // runtime — cancel a run by execution id
 * const result = yield* cancelFlowExecutions({
 *   executionIds: [executionId],
 * });
 * // result.invalidExecutions lists ids that could not be canceled
 * ```
 */
export interface CancelFlowExecutions extends Binding.Service<
  CancelFlowExecutions,
  "AWS.AppFlow.CancelFlowExecutions",
  (
    flow: Flow,
  ) => Effect.Effect<
    (
      request?: CancelFlowExecutionsRequest,
    ) => Effect.Effect<
      appflow.CancelFlowExecutionsResponse,
      appflow.CancelFlowExecutionsError
    >
  >
> {}

export const CancelFlowExecutions = Binding.Service<CancelFlowExecutions>(
  "AWS.AppFlow.CancelFlowExecutions",
);
