import type {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  OrchestrationV2CheckpointRepository,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface ThreadCheckpointSummary {
  readonly checkpointId?: CheckpointId;
  readonly scopeId?: CheckpointScopeId;
  readonly runId: RunId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: "ready" | "missing" | "error" | "stale";
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  /** Repository worktrees in this turn; their paths in `files` start with each `pathPrefix`. */
  readonly repositories?: ReadonlyArray<OrchestrationV2CheckpointRepository>;
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}

/**
 * Where a path from a checkpoint's files or diff lives: in a repository
 * worktree when it starts with that worktree's prefix, otherwise in the
 * thread's own workspace.
 */
export function resolveCheckpointFilePath(
  repositories:
    | ReadonlyArray<Pick<OrchestrationV2CheckpointRepository, "pathPrefix" | "worktreePath">>
    | undefined,
  filePath: string,
): { readonly worktreePath: string; readonly relativePath: string } | null {
  let match: { readonly worktreePath: string; readonly relativePath: string } | null = null;
  let matchedLength = -1;
  for (const repository of repositories ?? []) {
    const prefix = `${repository.pathPrefix}/`;
    if (filePath.startsWith(prefix) && prefix.length > matchedLength) {
      matchedLength = prefix.length;
      match = {
        worktreePath: repository.worktreePath,
        relativePath: filePath.slice(prefix.length),
      };
    }
  }
  return match;
}

export function deriveThreadCheckpointSummaries(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<ThreadCheckpointSummary> {
  return projection.checkpoints.flatMap((checkpoint) => {
    if (checkpoint.appRunOrdinal === null || checkpoint.runId === null) return [];
    const assistantMessageId =
      projection.messages.findLast(
        (message) => message.runId === checkpoint.runId && message.role === "assistant",
      )?.id ?? null;
    return [
      {
        checkpointId: checkpoint.id,
        scopeId: checkpoint.scopeId,
        runId: checkpoint.runId,
        checkpointTurnCount: checkpoint.appRunOrdinal,
        checkpointRef: checkpoint.ref,
        status: checkpoint.status,
        files: checkpoint.files,
        ...(checkpoint.repositories === undefined ? {} : { repositories: checkpoint.repositories }),
        assistantMessageId,
        completedAt: DateTime.formatIso(checkpoint.capturedAt),
      },
    ];
  });
}
