import type * as appflow from "@distilled.cloud/aws/appflow";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Flow } from "./Flow.ts";

/**
 * Runtime binding for `appflow:StopFlow`.
 *
 * Bind this operation to a {@link Flow} in the function's init phase to get a
 * callable that deactivates a schedule or event-triggered flow. On-demand
 * flows cannot be stopped — AppFlow rejects them with a typed
 * `UnsupportedOperationException`. The flow name is injected automatically
 * and `appflow:StopFlow` is granted on the flow. Provide the implementation
 * with `Effect.provide(AWS.AppFlow.StopFlowHttp)`.
 * @binding
 * @section Running Flows
 * @example Deactivate a Scheduled Flow from a Handler
 * ```typescript
 * // init — bind the operation to the flow
 * const stopFlow = yield* AWS.AppFlow.StopFlow(flow);
 *
 * // runtime — deactivate the flow
 * const result = yield* stopFlow();
 * // result.flowStatus === "Suspended"
 * ```
 */
export interface StopFlow extends Binding.Service<
  StopFlow,
  "AWS.AppFlow.StopFlow",
  (
    flow: Flow,
  ) => Effect.Effect<
    () => Effect.Effect<appflow.StopFlowResponse, appflow.StopFlowError>
  >
> {}

export const StopFlow = Binding.Service<StopFlow>("AWS.AppFlow.StopFlow");
