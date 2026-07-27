import type * as mediatailor from "@distilled.cloud/aws/mediatailor";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `mediatailor:ListAlerts` — read the operational alerts
 * MediaTailor raises for a channel-assembly resource (channel, source
 * location, VOD/live source) identified by ARN.
 *
 * Resource ARNs are runtime parameters, so the binding is account-level and
 * grants `mediatailor:ListAlerts` on `*`. Provide the implementation with
 * `Effect.provide(AWS.MediaTailor.ListAlertsHttp)`.
 *
 * @binding
 * @section Channel Assembly
 * @example Check a channel for alerts
 * ```typescript
 * const listAlerts = yield* AWS.MediaTailor.ListAlerts();
 *
 * const { Items } = yield* listAlerts({ ResourceArn: channelArn });
 * ```
 */
export interface ListAlerts extends Binding.Service<
  ListAlerts,
  "AWS.MediaTailor.ListAlerts",
  () => Effect.Effect<
    (
      request: mediatailor.ListAlertsRequest,
    ) => Effect.Effect<
      mediatailor.ListAlertsResponse,
      mediatailor.ListAlertsError
    >
  >
> {}
export const ListAlerts = Binding.Service<ListAlerts>(
  "AWS.MediaTailor.ListAlerts",
);
