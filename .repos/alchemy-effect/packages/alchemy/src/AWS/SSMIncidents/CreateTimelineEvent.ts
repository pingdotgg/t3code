import type * as incidents from "@distilled.cloud/aws/ssm-incidents";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-incidents:CreateTimelineEvent`.
 *
 * Adds a custom event to an incident's timeline — automation can annotate the
 * incident as it works (diagnosis steps, mitigation actions, links). Timeline
 * events live under runtime incident-record ARNs, so the deploy-time grant is
 * account-level (`Resource: "*"`).
 * Provide the implementation with
 * `Effect.provide(AWS.SSMIncidents.CreateTimelineEventHttp)`.
 * @binding
 * @section Timeline Events
 * @example Annotate An Incident
 * ```typescript
 * // init
 * const createTimelineEvent = yield* AWS.SSMIncidents.CreateTimelineEvent();
 *
 * // runtime
 * const { eventId } = yield* createTimelineEvent({
 *   incidentRecordArn,
 *   eventTime: new Date(),
 *   eventType: "Custom Event",
 *   eventData: JSON.stringify({ note: "traffic shifted to us-west-2" }),
 * });
 * ```
 */
export interface CreateTimelineEvent extends Binding.Service<
  CreateTimelineEvent,
  "AWS.SSMIncidents.CreateTimelineEvent",
  () => Effect.Effect<
    (
      request: incidents.CreateTimelineEventInput,
    ) => Effect.Effect<
      incidents.CreateTimelineEventOutput,
      incidents.CreateTimelineEventError
    >
  >
> {}
export const CreateTimelineEvent = Binding.Service<CreateTimelineEvent>(
  "AWS.SSMIncidents.CreateTimelineEvent",
);
