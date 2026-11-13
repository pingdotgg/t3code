import type {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  OrchestrationV2CheckpointFileTotals,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  changedFileTotals,
  deriveTurnRepositoryChanges,
  type TurnRepositoryChanges,
} from "./threadRepositories.ts";

export interface ThreadCheckpointSummary {
  readonly checkpointId?: CheckpointId;
  readonly scopeId?: CheckpointScopeId;
  readonly runId: RunId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: "ready" | "missing" | "error" | "stale";
  /** A prefix of the changed files when `filesTotal` is set; see `checkpointFileTotals`. */
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly filesTotal?: OrchestrationV2CheckpointFileTotals;
  /**
   * Tracked repositories this turn changed, by name; set only when there are any. `files` above
   * stays the thread folder's own, so a turn can have repositories while `status` is `missing`.
   */
  readonly repositories?: ReadonlyArray<TurnRepositoryChanges>;
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}

export function deriveThreadCheckpointSummaries(
  projection: Pick<OrchestrationV2ThreadProjection, "checkpoints" | "messages"> &
    Partial<Pick<OrchestrationV2ThreadProjection, "checkpointScopes">>,
): ReadonlyArray<ThreadCheckpointSummary> {
  const repositoriesByRun =
    projection.checkpointScopes === undefined
      ? undefined
      : deriveTurnRepositoryChanges({
          checkpoints: projection.checkpoints,
          checkpointScopes: projection.checkpointScopes,
        });
  let assistantMessageIdsByRun: Map<RunId, MessageId | null | undefined> | undefined;
  let nextMessageIndex = -1;
  return projection.checkpoints.flatMap((checkpoint) => {
    if (checkpoint.appRunOrdinal === null || checkpoint.runId === null) return [];
    const messages = projection.messages;
    if (assistantMessageIdsByRun === undefined) {
      assistantMessageIdsByRun = new Map();
      for (const entry of projection.checkpoints) {
        if (entry.appRunOrdinal !== null && entry.runId !== null) {
          assistantMessageIdsByRun.set(entry.runId, undefined);
        }
      }
      nextMessageIndex = messages.length - 1;
    }
    // Resume the reverse scan only as far as this checkpoint needs. Recent
    // checkpoints must not force a traversal of unrelated older history.
    while (nextMessageIndex >= 0 && assistantMessageIdsByRun.get(checkpoint.runId) === undefined) {
      const message = messages[nextMessageIndex--]!;
      const { runId, role } = message;
      if (
        role === "assistant" &&
        runId !== null &&
        assistantMessageIdsByRun.has(runId) &&
        assistantMessageIdsByRun.get(runId) === undefined
      ) {
        assistantMessageIdsByRun.set(runId, message.id ?? null);
      }
    }
    const assistantMessageId = assistantMessageIdsByRun.get(checkpoint.runId) ?? null;
    const repositories = repositoriesByRun?.get(checkpoint.runId);
    return [
      {
        checkpointId: checkpoint.id,
        scopeId: checkpoint.scopeId,
        runId: checkpoint.runId,
        checkpointTurnCount: checkpoint.appRunOrdinal,
        checkpointRef: checkpoint.ref,
        status: checkpoint.status,
        files: checkpoint.files,
        ...(checkpoint.filesTotal === undefined ? {} : { filesTotal: checkpoint.filesTotal }),
        ...(repositories === undefined ? {} : { repositories }),
        assistantMessageId,
        completedAt: DateTime.formatIso(checkpoint.capturedAt),
      },
    ];
  });
}

/** The thread folder's own totals; `turnChanges` adds the repositories. */
export function checkpointFileTotals(
  checkpoint: Pick<ThreadCheckpointSummary, "files" | "filesTotal">,
): OrchestrationV2CheckpointFileTotals {
  return changedFileTotals(checkpoint);
}
