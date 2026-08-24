import type * as eventbridge from "@distilled.cloud/aws/eventbridge";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface CancelReplayRequest extends eventbridge.CancelReplayRequest {}

/**
 * Cancels a running event replay (`events:CancelReplay`).
 *
 * Bind this operation inside a function runtime to abort a replay started
 * with `StartReplay`. Cancelling a replay that already completed fails with
 * the typed `IllegalStatusException`. Provide the `CancelReplayHttp` layer
 * on the Function to satisfy the binding.
 * @binding
 * @section Replaying Events
 * @example Cancel a Running Replay
 * ```typescript
 * // init — bind the operation (provide AWS.EventBridge.CancelReplayHttp on the Function)
 * const cancelReplay = yield* AWS.EventBridge.CancelReplay();
 *
 * // runtime — abort the replay
 * yield* cancelReplay({ ReplayName: "backfill-2026-07-14" });
 * ```
 */
export interface CancelReplay extends Binding.Service<
  CancelReplay,
  "AWS.EventBridge.CancelReplay",
  () => Effect.Effect<
    (
      request: CancelReplayRequest,
    ) => Effect.Effect<
      eventbridge.CancelReplayResponse,
      eventbridge.CancelReplayError
    >
  >
> {}
export const CancelReplay = Binding.Service<CancelReplay>(
  "AWS.EventBridge.CancelReplay",
);
