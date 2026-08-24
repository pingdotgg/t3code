import type * as medialive from "@distilled.cloud/aws/medialive";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Channel } from "./Channel.ts";

/**
 * Runtime binding for `medialive:RestartChannelPipelines`.
 *
 * Restarts one or both encoder pipelines of the bound RUNNING
 * {@link Channel} without a full stop/start cycle — the standard remedy
 * for a wedged pipeline (frozen output, persistent alert) that an
 * automated-recovery Lambda applies when a channel alert fires. The
 * channel id is injected from the binding. Provide the implementation
 * with `Effect.provide(AWS.MediaLive.RestartChannelPipelinesHttp)`.
 * @binding
 * @section Controlling Channels
 * @example Restart a Wedged Pipeline
 * ```typescript
 * // init — bind the operation to the channel
 * const restartPipelines = yield* AWS.MediaLive.RestartChannelPipelines(channel);
 *
 * // runtime
 * yield* restartPipelines({ PipelineIds: ["PIPELINE_0"] });
 * ```
 */
export interface RestartChannelPipelines extends Binding.Service<
  RestartChannelPipelines,
  "AWS.MediaLive.RestartChannelPipelines",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request?: Omit<medialive.RestartChannelPipelinesRequest, "ChannelId">,
    ) => Effect.Effect<
      medialive.RestartChannelPipelinesResponse,
      medialive.RestartChannelPipelinesError
    >
  >
> {}
export const RestartChannelPipelines = Binding.Service<RestartChannelPipelines>(
  "AWS.MediaLive.RestartChannelPipelines",
);
