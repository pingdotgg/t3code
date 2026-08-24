import type * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stage } from "./Stage.ts";

/**
 * The `sourceStageArn` and `destinationStageArn` are injected by the binding
 * from the bound stages.
 */
export interface StopParticipantReplicationRequest extends Omit<
  ivsrealtime.StopParticipantReplicationRequest,
  "sourceStageArn" | "destinationStageArn"
> {}

/**
 * Stop replicating a participant's media from the bound source stage into
 * the bound destination stage.
 *
 * @binding
 * @section Replicating Participants
 * @example Stop a replication
 * ```typescript
 * // init — bound to (source, destination)
 * const stopParticipantReplication =
 *   yield* IVSRealtime.StopParticipantReplication(mainStage, overflowStage);
 *
 * // runtime
 * yield* stopParticipantReplication({ participantId: "abcDEF123" });
 * ```
 */
export interface StopParticipantReplication extends Binding.Service<
  StopParticipantReplication,
  "AWS.IVSRealtime.StopParticipantReplication",
  (
    sourceStage: Stage,
    destinationStage: Stage,
  ) => Effect.Effect<
    (
      request: StopParticipantReplicationRequest,
    ) => Effect.Effect<
      ivsrealtime.StopParticipantReplicationResponse,
      ivsrealtime.StopParticipantReplicationError
    >
  >
> {}
export const StopParticipantReplication =
  Binding.Service<StopParticipantReplication>(
    "AWS.IVSRealtime.StopParticipantReplication",
  );
