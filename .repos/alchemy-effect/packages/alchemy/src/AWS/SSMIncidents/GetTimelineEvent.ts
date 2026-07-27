import type * as incidents from "@distilled.cloud/aws/ssm-incidents";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-incidents:GetTimelineEvent`.
 *
 * Returns one timeline event of an incident by event id. Timeline events live
 * under runtime incident-record ARNs, so the deploy-time grant is
 * account-level (`Resource: "*"`).
 * Provide the implementation with
 * `Effect.provide(AWS.SSMIncidents.GetTimelineEventHttp)`.
 * @binding
 * @section Timeline Events
 * @example Read A Timeline Event
 * ```typescript
 * // init
 * const getTimelineEvent = yield* AWS.SSMIncidents.GetTimelineEvent();
 *
 * // runtime
 * const { event } = yield* getTimelineEvent({ incidentRecordArn, eventId });
 * ```
 */
export interface GetTimelineEvent extends Binding.Service<
  GetTimelineEvent,
  "AWS.SSMIncidents.GetTimelineEvent",
  () => Effect.Effect<
    (
      request: incidents.GetTimelineEventInput,
    ) => Effect.Effect<
      incidents.GetTimelineEventOutput,
      incidents.GetTimelineEventError
    >
  >
> {}
export const GetTimelineEvent = Binding.Service<GetTimelineEvent>(
  "AWS.SSMIncidents.GetTimelineEvent",
);
