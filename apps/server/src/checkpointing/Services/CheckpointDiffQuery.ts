/**
 * CheckpointDiffQuery - Query interface for computed checkpoint diffs.
 *
 * Provides read-only diff operations across checkpoint snapshots used by
 * orchestration APIs.
 *
 * @module CheckpointDiffQuery
 */
import type {
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { CheckpointServiceError } from "../Errors.ts";

/**
 * CheckpointDiffQueryShape - Service API for checkpoint diff queries.
 */
export interface CheckpointDiffQueryShape {
  /**
   * Read the patch diff for a single turn checkpoint transition.
   *
   * Verifies checkpoint availability in both projection state and filesystem.
   */
  readonly getTurnDiff: (
    input: OrchestrationGetTurnDiffInput,
  ) => Effect.Effect<OrchestrationGetTurnDiffResult, CheckpointServiceError>;

  /**
   * Read the full patch diff across a thread range of checkpoints.
   *
   * Delegates to turn diff with `fromTurnCount = 0`.
   */
  readonly getFullThreadDiff: (
    input: OrchestrationGetFullThreadDiffInput,
  ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;
}

/**
 * CheckpointDiffQuery - Service tag for checkpoint diff queries.
 */
export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  CheckpointDiffQueryShape
>()("t3/checkpointing/Services/CheckpointDiffQuery") {}
