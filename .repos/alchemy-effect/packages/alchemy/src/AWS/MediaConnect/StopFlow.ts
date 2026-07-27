import type * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Flow } from "./Flow.ts";

/**
 * Runtime binding for `mediaconnect:StopFlow`.
 *
 * Stops the bound {@link Flow}, transitioning it from `ACTIVE` through
 * `STOPPING` back to `STANDBY` (where it no longer bills for transport).
 * Stopping a flow that is not running fails with the typed
 * `BadRequestException` tag. The flow ARN is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.MediaConnect.StopFlowHttp)`.
 * @binding
 * @section Controlling Flows
 * @example Stop the Flow After the Broadcast
 * ```typescript
 * // init — bind the operation to the flow
 * const stopFlow = yield* AWS.MediaConnect.StopFlow(flow);
 *
 * // runtime — a flow that is already in STANDBY answers with the typed
 * // BadRequestException tag
 * yield* stopFlow().pipe(
 *   Effect.catchTag("BadRequestException", () => Effect.void),
 * );
 * ```
 */
export interface StopFlow extends Binding.Service<
  StopFlow,
  "AWS.MediaConnect.StopFlow",
  (
    flow: Flow,
  ) => Effect.Effect<
    () => Effect.Effect<
      mediaconnect.StopFlowResponse,
      mediaconnect.StopFlowError
    >
  >
> {}
export const StopFlow = Binding.Service<StopFlow>("AWS.MediaConnect.StopFlow");
