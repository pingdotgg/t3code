import type * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stage } from "./Stage.ts";

/** The `stageArn` is injected by the binding from the bound stage. */
export interface GetParticipantRequest extends Omit<
  ivsrealtime.GetParticipantRequest,
  "stageArn"
> {}

/**
 * Read a participant's detail (state, join time, attributes, publish state,
 * recording state, connection metadata) for a session of the bound stage.
 *
 * @binding
 * @section Inspecting Participants
 * @example Look up a participant
 * ```typescript
 * // init
 * const getParticipant = yield* IVSRealtime.GetParticipant(stage);
 *
 * // runtime
 * const { participant } = yield* getParticipant({
 *   sessionId: "st-a1b2c3d4e5f6",
 *   participantId: "abcDEF123",
 * });
 * ```
 */
export interface GetParticipant extends Binding.Service<
  GetParticipant,
  "AWS.IVSRealtime.GetParticipant",
  (
    stage: Stage,
  ) => Effect.Effect<
    (
      request: GetParticipantRequest,
    ) => Effect.Effect<
      ivsrealtime.GetParticipantResponse,
      ivsrealtime.GetParticipantError
    >
  >
> {}
export const GetParticipant = Binding.Service<GetParticipant>(
  "AWS.IVSRealtime.GetParticipant",
);
