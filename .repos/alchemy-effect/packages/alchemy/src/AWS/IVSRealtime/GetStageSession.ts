import type * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stage } from "./Stage.ts";

/** The `stageArn` is injected by the binding from the bound stage. */
export interface GetStageSessionRequest extends Omit<
  ivsrealtime.GetStageSessionRequest,
  "stageArn"
> {}

/**
 * Read a session of the bound stage — its start time and, once the last
 * participant leaves, its end time.
 *
 * @binding
 * @section Inspecting Stage Sessions
 * @example Look up a session
 * ```typescript
 * // init
 * const getStageSession = yield* IVSRealtime.GetStageSession(stage);
 *
 * // runtime
 * const { stageSession } = yield* getStageSession({
 *   sessionId: "st-a1b2c3d4e5f6",
 * });
 * ```
 */
export interface GetStageSession extends Binding.Service<
  GetStageSession,
  "AWS.IVSRealtime.GetStageSession",
  (
    stage: Stage,
  ) => Effect.Effect<
    (
      request: GetStageSessionRequest,
    ) => Effect.Effect<
      ivsrealtime.GetStageSessionResponse,
      ivsrealtime.GetStageSessionError
    >
  >
> {}
export const GetStageSession = Binding.Service<GetStageSession>(
  "AWS.IVSRealtime.GetStageSession",
);
