import type * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Flow } from "./Flow.ts";

/**
 * Runtime binding for `mediaconnect:StartFlow`.
 *
 * Starts the bound {@link Flow}, transitioning it from `STANDBY` through
 * `STARTING` to `ACTIVE`. An ACTIVE flow ingests and egresses media and
 * bills hourly — pair with {@link StopFlow} to control transport cost
 * (e.g. a scheduler Lambda that runs the flow only during broadcast
 * windows). The flow ARN is injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.MediaConnect.StartFlowHttp)`.
 * @binding
 * @section Controlling Flows
 * @example Start the Flow for a Broadcast Window
 * ```typescript
 * // init — bind the operation to the flow
 * const startFlow = yield* AWS.MediaConnect.StartFlow(flow);
 *
 * // runtime
 * const { Status } = yield* startFlow();
 * ```
 */
export interface StartFlow extends Binding.Service<
  StartFlow,
  "AWS.MediaConnect.StartFlow",
  (
    flow: Flow,
  ) => Effect.Effect<
    () => Effect.Effect<
      mediaconnect.StartFlowResponse,
      mediaconnect.StartFlowError
    >
  >
> {}
export const StartFlow = Binding.Service<StartFlow>(
  "AWS.MediaConnect.StartFlow",
);
