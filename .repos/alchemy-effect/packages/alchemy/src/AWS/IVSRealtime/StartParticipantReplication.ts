import type * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stage } from "./Stage.ts";

/**
 * The `sourceStageArn` and `destinationStageArn` are injected by the binding
 * from the bound stages, and the wire `reconnectWindowSeconds` is expressed
 * as a `Duration.Input`.
 */
export interface StartParticipantReplicationRequest extends Omit<
  ivsrealtime.StartParticipantReplicationRequest,
  "sourceStageArn" | "destinationStageArn" | "reconnectWindowSeconds"
> {
  /**
   * If the participant disconnects and reconnects within this window, the
   * replication continues seamlessly. Converted to whole seconds on the
   * wire (`0` - `300` seconds).
   * @default 0
   */
  reconnectWindow?: Duration.Input;
}

/**
 * Replicate a participant's media from the bound source stage into the
 * bound destination stage — e.g. to bring a guest publisher into a second
 * room without a re-publish.
 *
 * @binding
 * @section Replicating Participants
 * @example Replicate a publisher into another stage
 * ```typescript
 * // init — bound to (source, destination)
 * const startParticipantReplication =
 *   yield* IVSRealtime.StartParticipantReplication(mainStage, overflowStage);
 *
 * // runtime
 * yield* startParticipantReplication({
 *   participantId: "abcDEF123",
 *   reconnectWindow: "30 seconds",
 * });
 * ```
 */
export interface StartParticipantReplication extends Binding.Service<
  StartParticipantReplication,
  "AWS.IVSRealtime.StartParticipantReplication",
  (
    sourceStage: Stage,
    destinationStage: Stage,
  ) => Effect.Effect<
    (
      request: StartParticipantReplicationRequest,
    ) => Effect.Effect<
      ivsrealtime.StartParticipantReplicationResponse,
      ivsrealtime.StartParticipantReplicationError
    >
  >
> {}
export const StartParticipantReplication =
  Binding.Service<StartParticipantReplication>(
    "AWS.IVSRealtime.StartParticipantReplication",
  );
