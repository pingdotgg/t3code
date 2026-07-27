import type * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stage } from "./Stage.ts";

/** The `stageArn` is injected by the binding from the bound stage. */
export interface DisconnectParticipantRequest extends Omit<
  ivsrealtime.DisconnectParticipantRequest,
  "stageArn"
> {}

/**
 * Forcibly disconnect a participant from the bound stage — the moderation
 * call made from a deployed Lambda or Task. If the participant is publishing
 * via an ingest configuration, its `stageArn` attachment is also cleared.
 *
 * @binding
 * @section Moderating Participants
 * @example Kick a participant from a Lambda
 * ```typescript
 * // init
 * const disconnectParticipant = yield* IVSRealtime.DisconnectParticipant(stage);
 *
 * // runtime
 * yield* disconnectParticipant({
 *   participantId: "abcDEF123",
 *   reason: "moderated",
 * });
 * ```
 */
export interface DisconnectParticipant extends Binding.Service<
  DisconnectParticipant,
  "AWS.IVSRealtime.DisconnectParticipant",
  (
    stage: Stage,
  ) => Effect.Effect<
    (
      request: DisconnectParticipantRequest,
    ) => Effect.Effect<
      ivsrealtime.DisconnectParticipantResponse,
      ivsrealtime.DisconnectParticipantError
    >
  >
> {}
export const DisconnectParticipant = Binding.Service<DisconnectParticipant>(
  "AWS.IVSRealtime.DisconnectParticipant",
);
