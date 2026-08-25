import type * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Read a composition's detail — state, layout, destinations, and per
 * destination progress. Compositions are addressed by the server-generated
 * ARN returned by `StartComposition`.
 *
 * @binding
 * @section Compositing a Stage
 * @example Poll a composition's state
 * ```typescript
 * // init
 * const getComposition = yield* IVSRealtime.GetComposition();
 *
 * // runtime
 * const { composition } = yield* getComposition({ arn: compositionArn });
 * // composition.state → "ACTIVE" | "STOPPED" | "FAILED" | …
 * ```
 */
export interface GetComposition extends Binding.Service<
  GetComposition,
  "AWS.IVSRealtime.GetComposition",
  () => Effect.Effect<
    (
      request: ivsrealtime.GetCompositionRequest,
    ) => Effect.Effect<
      ivsrealtime.GetCompositionResponse,
      ivsrealtime.GetCompositionError
    >
  >
> {}
export const GetComposition = Binding.Service<GetComposition>(
  "AWS.IVSRealtime.GetComposition",
);
