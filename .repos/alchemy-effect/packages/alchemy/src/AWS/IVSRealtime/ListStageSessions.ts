import type * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stage } from "./Stage.ts";

/** The `stageArn` is injected by the binding from the bound stage. */
export interface ListStageSessionsRequest extends Omit<
  ivsrealtime.ListStageSessionsRequest,
  "stageArn"
> {}

/**
 * List all sessions (current and past) of the bound stage, most recent
 * first.
 *
 * @binding
 * @section Inspecting Stage Sessions
 * @example List a stage's sessions
 * ```typescript
 * // init
 * const listStageSessions = yield* IVSRealtime.ListStageSessions(stage);
 *
 * // runtime
 * const { stageSessions } = yield* listStageSessions();
 * ```
 */
export interface ListStageSessions extends Binding.Service<
  ListStageSessions,
  "AWS.IVSRealtime.ListStageSessions",
  (
    stage: Stage,
  ) => Effect.Effect<
    (
      request?: ListStageSessionsRequest,
    ) => Effect.Effect<
      ivsrealtime.ListStageSessionsResponse,
      ivsrealtime.ListStageSessionsError
    >
  >
> {}
export const ListStageSessions = Binding.Service<ListStageSessions>(
  "AWS.IVSRealtime.ListStageSessions",
);
