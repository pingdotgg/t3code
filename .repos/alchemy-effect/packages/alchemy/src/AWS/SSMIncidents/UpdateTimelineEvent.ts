import type * as incidents from "@distilled.cloud/aws/ssm-incidents";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-incidents:UpdateTimelineEvent`.
 *
 * Updates a timeline event's time, type, data, or references. Timeline events
 * live under runtime incident-record ARNs, so the deploy-time grant is
 * account-level (`Resource: "*"`).
 * Provide the implementation with
 * `Effect.provide(AWS.SSMIncidents.UpdateTimelineEventHttp)`.
 * @binding
 * @section Timeline Events
 * @example Amend A Timeline Event
 * ```typescript
 * // init
 * const updateTimelineEvent = yield* AWS.SSMIncidents.UpdateTimelineEvent();
 *
 * // runtime
 * yield* updateTimelineEvent({
 *   incidentRecordArn,
 *   eventId,
 *   eventData: JSON.stringify({ note: "mitigation confirmed" }),
 * });
 * ```
 */
export interface UpdateTimelineEvent extends Binding.Service<
  UpdateTimelineEvent,
  "AWS.SSMIncidents.UpdateTimelineEvent",
  () => Effect.Effect<
    (
      request: incidents.UpdateTimelineEventInput,
    ) => Effect.Effect<
      incidents.UpdateTimelineEventOutput,
      incidents.UpdateTimelineEventError
    >
  >
> {}
export const UpdateTimelineEvent = Binding.Service<UpdateTimelineEvent>(
  "AWS.SSMIncidents.UpdateTimelineEvent",
);
