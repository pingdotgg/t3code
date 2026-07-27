import type * as incidents from "@distilled.cloud/aws/ssm-incidents";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-incidents:DeleteTimelineEvent`.
 *
 * Deletes a custom timeline event from an incident (idempotent — deleting an
 * event that does not exist succeeds). Timeline events live under runtime
 * incident-record ARNs, so the deploy-time grant is account-level
 * (`Resource: "*"`).
 * Provide the implementation with
 * `Effect.provide(AWS.SSMIncidents.DeleteTimelineEventHttp)`.
 * @binding
 * @section Timeline Events
 * @example Delete A Timeline Event
 * ```typescript
 * // init
 * const deleteTimelineEvent = yield* AWS.SSMIncidents.DeleteTimelineEvent();
 *
 * // runtime
 * yield* deleteTimelineEvent({ incidentRecordArn, eventId });
 * ```
 */
export interface DeleteTimelineEvent extends Binding.Service<
  DeleteTimelineEvent,
  "AWS.SSMIncidents.DeleteTimelineEvent",
  () => Effect.Effect<
    (
      request: incidents.DeleteTimelineEventInput,
    ) => Effect.Effect<
      incidents.DeleteTimelineEventOutput,
      incidents.DeleteTimelineEventError
    >
  >
> {}
export const DeleteTimelineEvent = Binding.Service<DeleteTimelineEvent>(
  "AWS.SSMIncidents.DeleteTimelineEvent",
);
