import type * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stage } from "./Stage.ts";

/** The `stageArn` is injected by the binding from the bound stage. */
export interface ListParticipantsRequest extends Omit<
  ivsrealtime.ListParticipantsRequest,
  "stageArn"
> {}

/**
 * List all participants in a session of the bound stage, optionally
 * filtered by user id, publish state, connection state, or recording state.
 *
 * @binding
 * @section Inspecting Participants
 * @example List a session's participants
 * ```typescript
 * // init
 * const listParticipants = yield* IVSRealtime.ListParticipants(stage);
 *
 * // runtime
 * const { participants } = yield* listParticipants({
 *   sessionId: "st-a1b2c3d4e5f6",
 *   filterByPublished: true,
 * });
 * ```
 */
export interface ListParticipants extends Binding.Service<
  ListParticipants,
  "AWS.IVSRealtime.ListParticipants",
  (
    stage: Stage,
  ) => Effect.Effect<
    (
      request: ListParticipantsRequest,
    ) => Effect.Effect<
      ivsrealtime.ListParticipantsResponse,
      ivsrealtime.ListParticipantsError
    >
  >
> {}
export const ListParticipants = Binding.Service<ListParticipants>(
  "AWS.IVSRealtime.ListParticipants",
);
