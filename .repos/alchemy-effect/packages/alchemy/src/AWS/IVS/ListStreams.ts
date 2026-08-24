import type * as ivs from "@distilled.cloud/aws/ivs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ivs:ListStreams`.
 *
 * Enumerates the account's live streams in the current region, optionally
 * filtered by stream health. This is an account-level operation — no
 * channel is bound, and the grant is on `*`. Provide the implementation
 * with `Effect.provide(AWS.IVS.ListStreamsHttp)`.
 * @binding
 * @section Monitoring Live Streams
 * @example Count Live Streams
 * ```typescript
 * // init — account-level, no resource to bind
 * const listStreams = yield* AWS.IVS.ListStreams();
 *
 * // runtime
 * const { streams } = yield* listStreams();
 * yield* Effect.log(`${streams.length} live streams`);
 * ```
 */
export interface ListStreams extends Binding.Service<
  ListStreams,
  "AWS.IVS.ListStreams",
  () => Effect.Effect<
    (
      request?: ivs.ListStreamsRequest,
    ) => Effect.Effect<ivs.ListStreamsResponse, ivs.ListStreamsError>
  >
> {}
export const ListStreams = Binding.Service<ListStreams>("AWS.IVS.ListStreams");
