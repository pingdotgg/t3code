import type * as medialive from "@distilled.cloud/aws/medialive";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Channel } from "./Channel.ts";

/**
 * Runtime binding for `medialive:DescribeThumbnails`.
 *
 * Fetches the latest preview thumbnail (base64 JPEG) from a pipeline of
 * the bound RUNNING {@link Channel} — e.g. a confidence-monitoring
 * dashboard that renders a live snapshot of what the channel is encoding.
 * Requires thumbnails to be enabled in the channel's encoder settings; a
 * channel that is not running answers with the typed
 * `BadRequestException` tag. The channel id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.MediaLive.DescribeThumbnailsHttp)`.
 * @binding
 * @section Observing Channels
 * @example Fetch the Latest Preview Thumbnail
 * ```typescript
 * // init — bind the operation to the channel
 * const describeThumbnails = yield* AWS.MediaLive.DescribeThumbnails(channel);
 *
 * // runtime
 * const { ThumbnailDetails } = yield* describeThumbnails({
 *   PipelineId: "0",
 *   ThumbnailType: "CURRENT_ACTIVE",
 * });
 * ```
 */
export interface DescribeThumbnails extends Binding.Service<
  DescribeThumbnails,
  "AWS.MediaLive.DescribeThumbnails",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request?: Omit<medialive.DescribeThumbnailsRequest, "ChannelId">,
    ) => Effect.Effect<
      medialive.DescribeThumbnailsResponse,
      medialive.DescribeThumbnailsError
    >
  >
> {}
export const DescribeThumbnails = Binding.Service<DescribeThumbnails>(
  "AWS.MediaLive.DescribeThumbnails",
);
