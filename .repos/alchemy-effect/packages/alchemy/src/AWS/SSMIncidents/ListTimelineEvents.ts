import type * as incidents from "@distilled.cloud/aws/ssm-incidents";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-incidents:ListTimelineEvents`.
 *
 * Lists the timeline events of an incident, with optional filters and sorting.
 * Timeline events live under runtime incident-record ARNs, so the deploy-time
 * grant is account-level (`Resource: "*"`).
 * Provide the implementation with
 * `Effect.provide(AWS.SSMIncidents.ListTimelineEventsHttp)`.
 * @binding
 * @section Timeline Events
 * @example List An Incident's Timeline
 * ```typescript
 * // init
 * const listTimelineEvents = yield* AWS.SSMIncidents.ListTimelineEvents();
 *
 * // runtime
 * const { eventSummaries } = yield* listTimelineEvents({
 *   incidentRecordArn,
 *   sortBy: "EVENT_TIME",
 *   sortOrder: "DESCENDING",
 * });
 * ```
 */
export interface ListTimelineEvents extends Binding.Service<
  ListTimelineEvents,
  "AWS.SSMIncidents.ListTimelineEvents",
  () => Effect.Effect<
    (
      request: incidents.ListTimelineEventsInput,
    ) => Effect.Effect<
      incidents.ListTimelineEventsOutput,
      incidents.ListTimelineEventsError
    >
  >
> {}
export const ListTimelineEvents = Binding.Service<ListTimelineEvents>(
  "AWS.SSMIncidents.ListTimelineEvents",
);
