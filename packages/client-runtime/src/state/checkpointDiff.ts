import type {
  EnvironmentId,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffResult,
  ThreadId,
} from "@t3tools/contracts";

export type CheckpointDiffResult =
  | OrchestrationGetTurnDiffResult
  | OrchestrationGetFullThreadDiffResult;

export interface CheckpointDiffState {
  readonly data: CheckpointDiffResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

export interface CheckpointDiffTarget {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly fromTurnCount: number | null;
  readonly toTurnCount: number | null;
  readonly ignoreWhitespace: boolean;
  readonly includeGitChanges?: boolean;
  readonly cacheScope?: string | null;
}
