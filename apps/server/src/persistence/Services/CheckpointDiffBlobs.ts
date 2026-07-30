import { IsoDateTime, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const CheckpointDiffBlob = Schema.Struct({
  threadId: ThreadId,
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
  diff: Schema.String,
  createdAt: IsoDateTime,
});
export type CheckpointDiffBlob = typeof CheckpointDiffBlob.Type;

export const GetCheckpointDiffBlobInput = Schema.Struct({
  threadId: ThreadId,
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
});
export type GetCheckpointDiffBlobInput = typeof GetCheckpointDiffBlobInput.Type;

export const DeleteCheckpointDiffBlobsByThreadIdInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteCheckpointDiffBlobsByThreadIdInput =
  typeof DeleteCheckpointDiffBlobsByThreadIdInput.Type;

export const DeleteCheckpointDiffBlobsAfterTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});
export type DeleteCheckpointDiffBlobsAfterTurnInput =
  typeof DeleteCheckpointDiffBlobsAfterTurnInput.Type;

export interface CheckpointDiffBlobRepositoryShape {
  readonly upsert: (row: CheckpointDiffBlob) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly get: (
    input: GetCheckpointDiffBlobInput,
  ) => Effect.Effect<Option.Option<CheckpointDiffBlob>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteCheckpointDiffBlobsByThreadIdInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteAfterTurn: (
    input: DeleteCheckpointDiffBlobsAfterTurnInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class CheckpointDiffBlobRepository extends Context.Service<
  CheckpointDiffBlobRepository,
  CheckpointDiffBlobRepositoryShape
>()("t3/persistence/Services/CheckpointDiffBlobs/CheckpointDiffBlobRepository") {}
