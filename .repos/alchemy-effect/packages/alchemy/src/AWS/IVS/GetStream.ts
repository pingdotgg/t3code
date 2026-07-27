import type * as ivs from "@distilled.cloud/aws/ivs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Channel } from "./Channel.ts";

/**
 * Runtime binding for `ivs:GetStream`.
 *
 * Reads the bound {@link Channel}'s active (live) stream — state, health,
 * viewer count, and playback URL. Fails with the typed
 * `ChannelNotBroadcasting` tag when the channel is not live. The channel
 * ARN is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IVS.GetStreamHttp)`.
 * @binding
 * @section Monitoring Live Streams
 * @example Check Whether a Channel Is Live
 * ```typescript
 * // init — bind the operation to the channel
 * const getStream = yield* AWS.IVS.GetStream(channel);
 *
 * // runtime
 * const live = yield* getStream().pipe(
 *   Effect.map(({ stream }) => ({ live: true, viewers: stream?.viewerCount })),
 *   Effect.catchTag("ChannelNotBroadcasting", () =>
 *     Effect.succeed({ live: false, viewers: 0 }),
 *   ),
 * );
 * ```
 */
export interface GetStream extends Binding.Service<
  GetStream,
  "AWS.IVS.GetStream",
  (
    channel: Channel,
  ) => Effect.Effect<
    () => Effect.Effect<ivs.GetStreamResponse, ivs.GetStreamError>
  >
> {}
export const GetStream = Binding.Service<GetStream>("AWS.IVS.GetStream");
