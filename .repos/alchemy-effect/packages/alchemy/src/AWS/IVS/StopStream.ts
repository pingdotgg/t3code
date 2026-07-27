import type * as ivs from "@distilled.cloud/aws/ivs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Channel } from "./Channel.ts";

/**
 * Runtime binding for `ivs:StopStream`.
 *
 * Disconnects the incoming RTMPS broadcast on the bound {@link Channel}.
 * Fails with the typed `ChannelNotBroadcasting` tag when the channel is
 * not live. Many broadcast clients auto-reconnect, so to stop a stream
 * permanently, first delete or rotate the channel's stream key. The
 * channel ARN is injected from the binding. Provide the implementation
 * with `Effect.provide(AWS.IVS.StopStreamHttp)`.
 * @binding
 * @section Controlling Live Streams
 * @example Kick the Current Broadcast
 * ```typescript
 * // init — bind the operation to the channel
 * const stopStream = yield* AWS.IVS.StopStream(channel);
 *
 * // runtime
 * yield* stopStream().pipe(
 *   Effect.catchTag("ChannelNotBroadcasting", () => Effect.void),
 * );
 * ```
 */
export interface StopStream extends Binding.Service<
  StopStream,
  "AWS.IVS.StopStream",
  (
    channel: Channel,
  ) => Effect.Effect<
    () => Effect.Effect<ivs.StopStreamResponse, ivs.StopStreamError>
  >
> {}
export const StopStream = Binding.Service<StopStream>("AWS.IVS.StopStream");
