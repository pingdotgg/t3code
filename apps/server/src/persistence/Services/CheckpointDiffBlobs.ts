import { IsoDateTime, NonNegativeInt, ThreadId } from "@forma/contracts";
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

export interface CheckpointDiffBlobRepositoryShape {
  readonly upsert: (row: CheckpointDiffBlob) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly get: (
    input: GetCheckpointDiffBlobInput,
  ) => Effect.Effect<Option.Option<CheckpointDiffBlob>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteCheckpointDiffBlobsByThreadIdInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class CheckpointDiffBlobRepository extends Context.Service<
  CheckpointDiffBlobRepository,
  CheckpointDiffBlobRepositoryShape
>()("forma/persistence/Services/CheckpointDiffBlobs/CheckpointDiffBlobRepository") {}
