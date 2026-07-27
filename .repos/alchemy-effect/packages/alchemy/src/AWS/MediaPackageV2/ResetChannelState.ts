import type * as mediapackagev2 from "@distilled.cloud/aws/mediapackagev2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Channel } from "./Channel.ts";

/**
 * Runtime binding for `mediapackagev2:ResetChannelState`.
 *
 * Resets the ingest state of the bound {@link Channel} — clearing buffered
 * content so the encoder can re-push a clean stream after a corrupted
 * contribution (e.g. an ops Lambda recovering a broken live event). The
 * channel's group and name are injected from the binding. Provide the
 * implementation with
 * `Effect.provide(AWS.MediaPackageV2.ResetChannelStateHttp)`.
 * @binding
 * @section Resetting Ingest State
 * @example Reset a Channel After a Corrupted Contribution
 * ```typescript
 * // init — bind the operation to the channel
 * const resetChannel = yield* AWS.MediaPackageV2.ResetChannelState(channel);
 *
 * // runtime
 * const { ResetAt } = yield* resetChannel();
 * ```
 */
export interface ResetChannelState extends Binding.Service<
  ResetChannelState,
  "AWS.MediaPackageV2.ResetChannelState",
  (
    channel: Channel,
  ) => Effect.Effect<
    () => Effect.Effect<
      mediapackagev2.ResetChannelStateResponse,
      mediapackagev2.ResetChannelStateError
    >
  >
> {}
export const ResetChannelState = Binding.Service<ResetChannelState>(
  "AWS.MediaPackageV2.ResetChannelState",
);
