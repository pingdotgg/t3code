import type * as eventbridge from "@distilled.cloud/aws/eventbridge";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DescribeReplayRequest
  extends eventbridge.DescribeReplayRequest {}

/**
 * Reads the progress and state of an event replay
 * (`events:DescribeReplay`).
 *
 * Bind this operation inside a function runtime to poll a replay started
 * with `StartReplay` until it completes. Provide the `DescribeReplayHttp`
 * layer on the Function to satisfy the binding.
 * @binding
 * @section Replaying Events
 * @example Poll a Replay's State
 * ```typescript
 * // init — bind the operation (provide AWS.EventBridge.DescribeReplayHttp on the Function)
 * const describeReplay = yield* AWS.EventBridge.DescribeReplay();
 *
 * // runtime — read the replay's state and progress
 * const replay = yield* describeReplay({ ReplayName: "backfill-2026-07-14" });
 * console.log(replay.State, replay.EventLastReplayedTime);
 * ```
 */
export interface DescribeReplay extends Binding.Service<
  DescribeReplay,
  "AWS.EventBridge.DescribeReplay",
  () => Effect.Effect<
    (
      request: DescribeReplayRequest,
    ) => Effect.Effect<
      eventbridge.DescribeReplayResponse,
      eventbridge.DescribeReplayError
    >
  >
> {}
export const DescribeReplay = Binding.Service<DescribeReplay>(
  "AWS.EventBridge.DescribeReplay",
);
