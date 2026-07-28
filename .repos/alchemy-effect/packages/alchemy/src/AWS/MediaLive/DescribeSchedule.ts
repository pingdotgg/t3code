import type * as medialive from "@distilled.cloud/aws/medialive";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Channel } from "./Channel.ts";

/**
 * Runtime binding for `medialive:DescribeSchedule`.
 *
 * Reads the bound {@link Channel}'s schedule — the queue of pending and
 * recent actions created with {@link BatchUpdateSchedule} (one page per
 * call; pass `NextToken` from the previous response to continue) — e.g.
 * so a playout dashboard can show upcoming input switches and ad breaks.
 * The channel id is injected from the binding. Provide the implementation
 * with `Effect.provide(AWS.MediaLive.DescribeScheduleHttp)`.
 * @binding
 * @section Driving the Channel Schedule
 * @example List the Channel's Scheduled Actions
 * ```typescript
 * // init — bind the operation to the channel
 * const describeSchedule = yield* AWS.MediaLive.DescribeSchedule(channel);
 *
 * // runtime
 * const { ScheduleActions } = yield* describeSchedule();
 * ```
 */
export interface DescribeSchedule extends Binding.Service<
  DescribeSchedule,
  "AWS.MediaLive.DescribeSchedule",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request?: Omit<medialive.DescribeScheduleRequest, "ChannelId">,
    ) => Effect.Effect<
      medialive.DescribeScheduleResponse,
      medialive.DescribeScheduleError
    >
  >
> {}
export const DescribeSchedule = Binding.Service<DescribeSchedule>(
  "AWS.MediaLive.DescribeSchedule",
);
