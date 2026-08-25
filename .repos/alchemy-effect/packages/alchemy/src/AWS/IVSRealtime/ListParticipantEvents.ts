import type * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stage } from "./Stage.ts";

/** The `stageArn` is injected by the binding from the bound stage. */
export interface ListParticipantEventsRequest extends Omit<
  ivsrealtime.ListParticipantEventsRequest,
  "stageArn"
> {}

/**
 * List the events (joined, left, publish started/stopped, errors) recorded
 * for a participant during a session of the bound stage.
 *
 * @binding
 * @section Inspecting Participants
 * @example Audit a participant's session events
 * ```typescript
 * // init
 * const listParticipantEvents = yield* IVSRealtime.ListParticipantEvents(stage);
 *
 * // runtime
 * const { events } = yield* listParticipantEvents({
 *   sessionId: "st-a1b2c3d4e5f6",
 *   participantId: "abcDEF123",
 * });
 * ```
 */
export interface ListParticipantEvents extends Binding.Service<
  ListParticipantEvents,
  "AWS.IVSRealtime.ListParticipantEvents",
  (
    stage: Stage,
  ) => Effect.Effect<
    (
      request: ListParticipantEventsRequest,
    ) => Effect.Effect<
      ivsrealtime.ListParticipantEventsResponse,
      ivsrealtime.ListParticipantEventsError
    >
  >
> {}
export const ListParticipantEvents = Binding.Service<ListParticipantEvents>(
  "AWS.IVSRealtime.ListParticipantEvents",
);
