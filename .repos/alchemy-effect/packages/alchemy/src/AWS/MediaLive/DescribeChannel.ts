import type * as medialive from "@distilled.cloud/aws/medialive";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Channel } from "./Channel.ts";

/**
 * Runtime binding for `medialive:DescribeChannel`.
 *
 * Reads the bound {@link Channel}'s live state — lifecycle state
 * (`IDLE`/`RUNNING`), pipeline details, egress endpoints, and attached
 * inputs — e.g. for an operations dashboard or a scheduler that only
 * starts a channel that is not already running. The channel id is
 * injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.MediaLive.DescribeChannelHttp)`.
 * @binding
 * @section Observing Channels
 * @example Read the Channel's Current State
 * ```typescript
 * // init — bind the operation to the channel
 * const describeChannel = yield* AWS.MediaLive.DescribeChannel(channel);
 *
 * // runtime
 * const { State } = yield* describeChannel();
 * const running = State === "RUNNING";
 * ```
 */
export interface DescribeChannel extends Binding.Service<
  DescribeChannel,
  "AWS.MediaLive.DescribeChannel",
  (
    channel: Channel,
  ) => Effect.Effect<
    () => Effect.Effect<
      medialive.DescribeChannelResponse,
      medialive.DescribeChannelError
    >
  >
> {}
export const DescribeChannel = Binding.Service<DescribeChannel>(
  "AWS.MediaLive.DescribeChannel",
);
