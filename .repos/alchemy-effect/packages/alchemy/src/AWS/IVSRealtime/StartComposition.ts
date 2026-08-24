import type * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stage } from "./Stage.ts";

/** The `stageArn` is injected by the binding from the bound stage. */
export interface StartCompositionRequest extends Omit<
  ivsrealtime.StartCompositionRequest,
  "stageArn"
> {}

/**
 * Start a server-side composition of the bound stage — IVS mixes the
 * stage's participants into a single video according to the `layout` and
 * delivers it to the given `destinations` (an IVS low-latency channel
 * and/or an S3 storage configuration).
 *
 * @binding
 * @section Compositing a Stage
 * @example Composite a stage into an IVS channel
 * ```typescript
 * // init
 * const startComposition = yield* IVSRealtime.StartComposition(stage);
 *
 * // runtime
 * const { composition } = yield* startComposition({
 *   destinations: [{ channel: { channelArn } }],
 *   layout: { grid: { videoAspectRatio: "VIDEO" } },
 * });
 * ```
 */
export interface StartComposition extends Binding.Service<
  StartComposition,
  "AWS.IVSRealtime.StartComposition",
  (
    stage: Stage,
  ) => Effect.Effect<
    (
      request: StartCompositionRequest,
    ) => Effect.Effect<
      ivsrealtime.StartCompositionResponse,
      ivsrealtime.StartCompositionError
    >
  >
> {}
export const StartComposition = Binding.Service<StartComposition>(
  "AWS.IVSRealtime.StartComposition",
);
