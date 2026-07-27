import type * as medialive from "@distilled.cloud/aws/medialive";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Channel } from "./Channel.ts";

/**
 * Runtime binding for `medialive:StartChannel`.
 *
 * Starts the bound {@link Channel}, transitioning it from `IDLE` through
 * `STARTING` to `RUNNING`. A RUNNING channel encodes and bills hourly —
 * pair with {@link StopChannel} to control encoding cost (e.g. a
 * scheduler Lambda that runs the channel only during broadcast windows).
 * The channel id is injected from the binding. Provide the implementation
 * with `Effect.provide(AWS.MediaLive.StartChannelHttp)`.
 * @binding
 * @section Controlling Channels
 * @example Start the Channel for a Broadcast Window
 * ```typescript
 * // init — bind the operation to the channel
 * const startChannel = yield* AWS.MediaLive.StartChannel(channel);
 *
 * // runtime
 * const { State } = yield* startChannel();
 * ```
 */
export interface StartChannel extends Binding.Service<
  StartChannel,
  "AWS.MediaLive.StartChannel",
  (
    channel: Channel,
  ) => Effect.Effect<
    () => Effect.Effect<
      medialive.StartChannelResponse,
      medialive.StartChannelError
    >
  >
> {}
export const StartChannel = Binding.Service<StartChannel>(
  "AWS.MediaLive.StartChannel",
);
