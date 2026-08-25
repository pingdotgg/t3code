import type * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Flow } from "./Flow.ts";

/**
 * Runtime binding for `mediaconnect:DescribeFlow`.
 *
 * Reads the bound {@link Flow}'s live state — status (`STANDBY`/`ACTIVE`),
 * source, outputs, and entitlements — e.g. for an operations dashboard or
 * a scheduler that only starts a flow that is not already running. The
 * flow ARN is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.MediaConnect.DescribeFlowHttp)`.
 * @binding
 * @section Observing Flows
 * @example Read the Flow's Current Status
 * ```typescript
 * // init — bind the operation to the flow
 * const describeFlow = yield* AWS.MediaConnect.DescribeFlow(flow);
 *
 * // runtime
 * const { Flow: current } = yield* describeFlow();
 * const running = current?.Status === "ACTIVE";
 * ```
 */
export interface DescribeFlow extends Binding.Service<
  DescribeFlow,
  "AWS.MediaConnect.DescribeFlow",
  (
    flow: Flow,
  ) => Effect.Effect<
    () => Effect.Effect<
      mediaconnect.DescribeFlowResponse,
      mediaconnect.DescribeFlowError
    >
  >
> {}
export const DescribeFlow = Binding.Service<DescribeFlow>(
  "AWS.MediaConnect.DescribeFlow",
);
