import type * as medialive from "@distilled.cloud/aws/medialive";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Channel } from "./Channel.ts";

/**
 * Runtime binding for `medialive:StopChannel`.
 *
 * Stops the bound {@link Channel}, transitioning it from `RUNNING`
 * through `STOPPING` back to `IDLE` — the other half of a broadcast-window
 * scheduler built on {@link StartChannel}. Stopping a channel that is not
 * running fails with the typed `ConflictException` tag. The channel id is
 * injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.MediaLive.StopChannelHttp)`.
 * @binding
 * @section Controlling Channels
 * @example Stop the Channel After the Broadcast
 * ```typescript
 * // init — bind the operation to the channel
 * const stopChannel = yield* AWS.MediaLive.StopChannel(channel);
 *
 * // runtime
 * const { State } = yield* stopChannel();
 * ```
 */
export interface StopChannel extends Binding.Service<
  StopChannel,
  "AWS.MediaLive.StopChannel",
  (
    channel: Channel,
  ) => Effect.Effect<
    () => Effect.Effect<
      medialive.StopChannelResponse,
      medialive.StopChannelError
    >
  >
> {}
export const StopChannel = Binding.Service<StopChannel>(
  "AWS.MediaLive.StopChannel",
);
