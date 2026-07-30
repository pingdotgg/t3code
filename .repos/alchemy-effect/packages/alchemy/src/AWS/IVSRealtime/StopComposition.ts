import type * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Stop and delete a composition — any broadcast to the composition's
 * destinations ends. Compositions are addressed by the server-generated
 * ARN returned by `StartComposition`.
 *
 * @binding
 * @section Compositing a Stage
 * @example Stop a running composition
 * ```typescript
 * // init
 * const stopComposition = yield* IVSRealtime.StopComposition();
 *
 * // runtime
 * yield* stopComposition({ arn: compositionArn });
 * ```
 */
export interface StopComposition extends Binding.Service<
  StopComposition,
  "AWS.IVSRealtime.StopComposition",
  () => Effect.Effect<
    (
      request: ivsrealtime.StopCompositionRequest,
    ) => Effect.Effect<
      ivsrealtime.StopCompositionResponse,
      ivsrealtime.StopCompositionError
    >
  >
> {}
export const StopComposition = Binding.Service<StopComposition>(
  "AWS.IVSRealtime.StopComposition",
);
