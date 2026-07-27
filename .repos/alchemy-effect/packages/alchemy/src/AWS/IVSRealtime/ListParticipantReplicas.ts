import type * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stage } from "./Stage.ts";

/**
 * The `sourceStageArn` is injected by the binding from the bound (source)
 * stage.
 */
export interface ListParticipantReplicasRequest extends Omit<
  ivsrealtime.ListParticipantReplicasRequest,
  "sourceStageArn"
> {}

/**
 * List the replicas of a participant of the bound (source) stage — the
 * destination stages a participant's media is replicated to and each
 * replica's state.
 *
 * @binding
 * @section Replicating Participants
 * @example List a participant's replicas
 * ```typescript
 * // init
 * const listParticipantReplicas = yield* IVSRealtime.ListParticipantReplicas(stage);
 *
 * // runtime
 * const { replicas } = yield* listParticipantReplicas({
 *   participantId: "abcDEF123",
 * });
 * ```
 */
export interface ListParticipantReplicas extends Binding.Service<
  ListParticipantReplicas,
  "AWS.IVSRealtime.ListParticipantReplicas",
  (
    stage: Stage,
  ) => Effect.Effect<
    (
      request: ListParticipantReplicasRequest,
    ) => Effect.Effect<
      ivsrealtime.ListParticipantReplicasResponse,
      ivsrealtime.ListParticipantReplicasError
    >
  >
> {}
export const ListParticipantReplicas = Binding.Service<ListParticipantReplicas>(
  "AWS.IVSRealtime.ListParticipantReplicas",
);
