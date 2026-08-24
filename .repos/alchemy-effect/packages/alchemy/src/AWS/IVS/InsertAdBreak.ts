import type * as ivs from "@distilled.cloud/aws/ivs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Channel } from "./Channel.ts";

export interface InsertAdBreakRequest extends Omit<
  ivs.InsertAdBreakRequest,
  "channelArn"
> {}

/**
 * Runtime binding for `ivs:InsertAdBreak`.
 *
 * Triggers a server-side ad break of the requested duration in the bound
 * {@link Channel}'s active stream (the channel must have an ad
 * configuration attached). Fails with the typed `ChannelNotBroadcasting`
 * tag when the channel is not live. The channel ARN is injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.IVS.InsertAdBreakHttp)`.
 * @binding
 * @section Inserting Ad Breaks
 * @example Trigger a 30-Second Ad Break
 * ```typescript
 * // init — bind the operation to the channel
 * const insertAdBreak = yield* AWS.IVS.InsertAdBreak(channel);
 *
 * // runtime
 * const { adBreakId } = yield* insertAdBreak({ durationSeconds: 30 });
 * ```
 */
export interface InsertAdBreak extends Binding.Service<
  InsertAdBreak,
  "AWS.IVS.InsertAdBreak",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: InsertAdBreakRequest,
    ) => Effect.Effect<ivs.InsertAdBreakResponse, ivs.InsertAdBreakError>
  >
> {}
export const InsertAdBreak = Binding.Service<InsertAdBreak>(
  "AWS.IVS.InsertAdBreak",
);
