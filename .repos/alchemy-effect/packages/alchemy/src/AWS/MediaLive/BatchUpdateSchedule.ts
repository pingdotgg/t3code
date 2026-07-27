import type * as medialive from "@distilled.cloud/aws/medialive";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Channel } from "./Channel.ts";

/**
 * Runtime binding for `medialive:BatchUpdateSchedule`.
 *
 * Adds and/or removes schedule actions on the bound {@link Channel} — ad
 * breaks (SCTE-35 splices), input switches, static image overlays, pause
 * states — the primary data-plane API for driving a live broadcast (e.g.
 * a playout-automation Lambda that switches inputs on a timecode). The
 * channel id is injected from the binding. Provide the implementation
 * with `Effect.provide(AWS.MediaLive.BatchUpdateScheduleHttp)`.
 * @binding
 * @section Driving the Channel Schedule
 * @example Schedule an Input Switch
 * ```typescript
 * // init — bind the operation to the channel
 * const updateSchedule = yield* AWS.MediaLive.BatchUpdateSchedule(channel);
 *
 * // runtime
 * yield* updateSchedule({
 *   Creates: {
 *     ScheduleActions: [
 *       {
 *         ActionName: "switch-to-backup",
 *         ScheduleActionStartSettings: {
 *           FixedModeScheduleActionStartSettings: {
 *             Time: "2026-01-01T00:00:00.000Z",
 *           },
 *         },
 *         ScheduleActionSettings: {
 *           InputSwitchSettings: { InputAttachmentNameReference: "backup" },
 *         },
 *       },
 *     ],
 *   },
 * });
 * ```
 */
export interface BatchUpdateSchedule extends Binding.Service<
  BatchUpdateSchedule,
  "AWS.MediaLive.BatchUpdateSchedule",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request?: Omit<medialive.BatchUpdateScheduleRequest, "ChannelId">,
    ) => Effect.Effect<
      medialive.BatchUpdateScheduleResponse,
      medialive.BatchUpdateScheduleError
    >
  >
> {}
export const BatchUpdateSchedule = Binding.Service<BatchUpdateSchedule>(
  "AWS.MediaLive.BatchUpdateSchedule",
);
