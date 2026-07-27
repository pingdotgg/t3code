import type * as medialive from "@distilled.cloud/aws/medialive";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Channel } from "./Channel.ts";

/**
 * Runtime binding for `medialive:DeleteSchedule`.
 *
 * Clears every scheduled action from the bound {@link Channel}'s schedule
 * in one call — the reset lever a playout-automation Lambda pulls before
 * programming a fresh broadcast rundown with {@link BatchUpdateSchedule}.
 * The channel id is injected from the binding. Provide the implementation
 * with `Effect.provide(AWS.MediaLive.DeleteScheduleHttp)`.
 * @binding
 * @section Driving the Channel Schedule
 * @example Reset the Channel's Schedule
 * ```typescript
 * // init — bind the operation to the channel
 * const deleteSchedule = yield* AWS.MediaLive.DeleteSchedule(channel);
 *
 * // runtime
 * yield* deleteSchedule();
 * ```
 */
export interface DeleteSchedule extends Binding.Service<
  DeleteSchedule,
  "AWS.MediaLive.DeleteSchedule",
  (
    channel: Channel,
  ) => Effect.Effect<
    () => Effect.Effect<
      medialive.DeleteScheduleResponse,
      medialive.DeleteScheduleError
    >
  >
> {}
export const DeleteSchedule = Binding.Service<DeleteSchedule>(
  "AWS.MediaLive.DeleteSchedule",
);
