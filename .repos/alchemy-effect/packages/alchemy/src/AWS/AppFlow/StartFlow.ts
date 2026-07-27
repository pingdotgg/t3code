import type * as appflow from "@distilled.cloud/aws/appflow";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Flow } from "./Flow.ts";

export interface StartFlowRequest extends Omit<
  appflow.StartFlowRequest,
  "flowName"
> {}

/**
 * Runtime binding for `appflow:StartFlow`.
 *
 * Bind this operation to a {@link Flow} in the function's init phase to get a
 * callable that activates the flow — for on-demand flows this triggers a
 * single run and returns its `executionId`; for schedule and event-triggered
 * flows it activates the flow. The flow name is injected automatically and
 * `appflow:StartFlow` is granted on the flow. Provide the implementation with
 * `Effect.provide(AWS.AppFlow.StartFlowHttp)`.
 * @binding
 * @section Running Flows
 * @example Start an On-Demand Flow Run from a Handler
 * ```typescript
 * export default MyFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     const flow = yield* AWS.AppFlow.Flow("CopyFlow", { ... });
 *     // init — bind the operation to the flow
 *     const startFlow = yield* AWS.AppFlow.StartFlow(flow);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime — trigger a run
 *         const run = yield* startFlow();
 *         return HttpServerResponse.json({ executionId: run.executionId });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(AWS.AppFlow.StartFlowHttp)),
 * );
 * ```
 */
export interface StartFlow extends Binding.Service<
  StartFlow,
  "AWS.AppFlow.StartFlow",
  (
    flow: Flow,
  ) => Effect.Effect<
    (
      request?: StartFlowRequest,
    ) => Effect.Effect<appflow.StartFlowResponse, appflow.StartFlowError>
  >
> {}

export const StartFlow = Binding.Service<StartFlow>("AWS.AppFlow.StartFlow");
