/**
 * ProjectionCheckpointRepository - Projection repository interface for checkpoints.
 *
 * Owns persistence operations for projected checkpoint summaries in thread
 * timelines.
 *
 * @module ProjectionCheckpointRepository
 */
import {
  CheckpointRef,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Schema } from "effect";

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
