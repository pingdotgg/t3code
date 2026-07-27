import type * as ivs from "@distilled.cloud/aws/ivs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Channel } from "./Channel.ts";

export interface PutMetadataRequest extends Omit<
  ivs.PutMetadataRequest,
  "channelArn"
> {}

/**
 * Runtime binding for `ivs:PutMetadata`.
 *
 * Inserts timed metadata (max 1 KB) into the bound {@link Channel}'s
 * active stream — the payload is embedded in the video and surfaced to
 * players in sync with playback. Fails with the typed
 * `ChannelNotBroadcasting` tag when the channel is not live. At most 5
 * requests per second per channel. The channel ARN is injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.IVS.PutMetadataHttp)`.
 * @binding
 * @section Embedding Timed Metadata
 * @example Push a Poll Question to Viewers
 * ```typescript
 * // init — bind the operation to the channel
 * const putMetadata = yield* AWS.IVS.PutMetadata(channel);
 *
 * // runtime
 * yield* putMetadata({
 *   metadata: JSON.stringify({ question: "Who wins?", options: ["A", "B"] }),
 * });
 * ```
 */
export interface PutMetadata extends Binding.Service<
  PutMetadata,
  "AWS.IVS.PutMetadata",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: PutMetadataRequest,
    ) => Effect.Effect<ivs.PutMetadataResponse, ivs.PutMetadataError>
  >
> {}
export const PutMetadata = Binding.Service<PutMetadata>("AWS.IVS.PutMetadata");
