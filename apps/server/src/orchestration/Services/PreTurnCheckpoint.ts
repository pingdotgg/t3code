/**
 * PreTurnCheckpoint - Synchronous prerequisite for provider turn dispatch.
 *
 * Ensures the workspace baseline for the next turn exists before provider
 * work is allowed to mutate the filesystem.
 *
 * @module PreTurnCheckpoint
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";

export interface EnsurePreTurnCheckpointInput {
  readonly threadId: ThreadId;
  readonly createdAt: string;
}

export interface PreTurnCheckpointShape {
  /**
   * Serialize filesystem boundaries for one workspace. Completion capture and
   * the next pre-turn baseline use this same lock so a later turn cannot begin
   * mutating files before the previous turn's checkpoint is finalized.
   */
  readonly withWorkspaceBoundary: <A, E, R>(
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;

  /**
   * Capture the current turn-count baseline when it does not already exist.
   * Missing threads, unresolved workspaces, and non-Git workspaces are no-ops.
   */
  readonly ensure: (
    input: EnsurePreTurnCheckpointInput,
  ) => Effect.Effect<
    void,
    CheckpointStoreError | ProjectionRepositoryError | OrchestrationDispatchError
  >;
}

export class PreTurnCheckpoint extends Context.Service<PreTurnCheckpoint, PreTurnCheckpointShape>()(
  "t3/orchestration/Services/PreTurnCheckpoint",
) {}
