import type * as medialive from "@distilled.cloud/aws/medialive";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Channel } from "./Channel.ts";

/**
 * Runtime binding for `medialive:ListAlerts`.
 *
 * Lists the bound {@link Channel}'s alerts — SET and CLEARED error
 * conditions such as a lost input or a failed output (one page per call;
 * pass `NextToken` from the previous response to continue). Filter with
 * `StateFilter: "SET"` to see only active problems — e.g. a health-check
 * Lambda that pages an operator while any alert is SET. The channel id is
 * injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.MediaLive.ListAlertsHttp)`.
 * @binding
 * @section Observing Channels
 * @example List the Channel's Active Alerts
 * ```typescript
 * // init — bind the operation to the channel
 * const listAlerts = yield* AWS.MediaLive.ListAlerts(channel);
 *
 * // runtime
 * const { Alerts } = yield* listAlerts({ StateFilter: "SET" });
 * ```
 */
export interface ListAlerts extends Binding.Service<
  ListAlerts,
  "AWS.MediaLive.ListAlerts",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request?: Omit<medialive.ListAlertsRequest, "ChannelId">,
    ) => Effect.Effect<medialive.ListAlertsResponse, medialive.ListAlertsError>
  >
> {}
export const ListAlerts = Binding.Service<ListAlerts>(
  "AWS.MediaLive.ListAlerts",
);
