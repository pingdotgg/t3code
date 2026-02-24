import { IsoDateTime, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { CheckpointDiffBlobRepositoryError } from "../Errors.ts";

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

export interface CheckpointDiffBlobRepositoryShape {
  readonly upsert: (
    blob: CheckpointDiffBlob,
  ) => Effect.Effect<void, CheckpointDiffBlobRepositoryError>;

  readonly get: (
    input: GetCheckpointDiffBlobInput,
  ) => Effect.Effect<Option.Option<CheckpointDiffBlob>, CheckpointDiffBlobRepositoryError>;
}

export class CheckpointDiffBlobRepository extends ServiceMap.Service<
  CheckpointDiffBlobRepository,
  CheckpointDiffBlobRepositoryShape
>()("persistence/CheckpointDiffBlobRepository") {}
