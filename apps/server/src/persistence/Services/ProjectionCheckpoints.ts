/** Checkpoint row schema consumed by projection snapshot queries. */
import {
  CheckpointRef,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
} from "@t3tools/contracts/legacy-orchestration";
import * as Schema from "effect/Schema";

export const ProjectionCheckpoint = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpoint = typeof ProjectionCheckpoint.Type;
