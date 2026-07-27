import type * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * List the account's compositions in the current region, optionally
 * filtered by stage or encoder configuration.
 *
 * @binding
 * @section Compositing a Stage
 * @example List running compositions
 * ```typescript
 * // init
 * const listCompositions = yield* IVSRealtime.ListCompositions();
 *
 * // runtime
 * const { compositions } = yield* listCompositions();
 * ```
 */
export interface ListCompositions extends Binding.Service<
  ListCompositions,
  "AWS.IVSRealtime.ListCompositions",
  () => Effect.Effect<
    (
      request?: ivsrealtime.ListCompositionsRequest,
    ) => Effect.Effect<
      ivsrealtime.ListCompositionsResponse,
      ivsrealtime.ListCompositionsError
    >
  >
> {}
export const ListCompositions = Binding.Service<ListCompositions>(
  "AWS.IVSRealtime.ListCompositions",
);
