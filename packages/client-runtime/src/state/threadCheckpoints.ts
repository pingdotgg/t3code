import type {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  OrchestrationV2CheckpointFileTotals,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointOutsideEdit,
  OrchestrationV2CheckpointScope,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { arrayElementsEqual } from "./entities.ts";

export interface ThreadCheckpointFileSummary {
  readonly path: string;
  readonly kind: string;
  readonly additions: number;
  readonly deletions: number;
}

/** A tracked repo's checkpoint from the same run as its root summary. */
export interface ThreadCheckpointRepositorySummary {
  readonly scopeId: CheckpointScopeId;
  readonly name: string;
  /** The project's tracked path, stable across task folders. */
  readonly repositoryPath: string;
  /** Where the checkpoint was captured; file paths are relative to it. */
  readonly cwd: string;
  readonly status: OrchestrationV2Checkpoint["status"];
  readonly files: ReadonlyArray<ThreadCheckpointFileSummary>;
}

export type ThreadCheckpointOutsideEdit = OrchestrationV2CheckpointOutsideEdit;

export interface ThreadCheckpointSummary {
  readonly checkpointId?: CheckpointId;
  readonly scopeId?: CheckpointScopeId;
  readonly runId: RunId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: "ready" | "missing" | "error" | "stale";
  /** A prefix of the home repo's changed files when `filesTotal` is set; see `checkpointFileTotals`. */
  readonly files: ReadonlyArray<ThreadCheckpointFileSummary>;
  readonly filesTotal?: OrchestrationV2CheckpointFileTotals;
  /** Empty for single-repo threads. */
  readonly repositories: ReadonlyArray<ThreadCheckpointRepositorySummary>;
  readonly outsideEdits: ReadonlyArray<ThreadCheckpointOutsideEdit>;
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}

const EMPTY_REPOSITORIES: ReadonlyArray<ThreadCheckpointRepositorySummary> = Object.freeze([]);
const EMPTY_OUTSIDE_EDITS: ReadonlyArray<ThreadCheckpointOutsideEdit> = Object.freeze([]);

// Projection updates keep unchanged checkpoints, so summaries are reused per checkpoint and
// timeline rows that compare them by identity skip re-rendering while a reply streams.
const summaryCache = new WeakMap<OrchestrationV2Checkpoint, ThreadCheckpointSummary>();
const repositorySummaryCache = new WeakMap<
  OrchestrationV2Checkpoint,
  {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly summary: ThreadCheckpointRepositorySummary;
  }
>();

function repositorySummary(
  checkpoint: OrchestrationV2Checkpoint,
  scope: OrchestrationV2CheckpointScope,
): ThreadCheckpointRepositorySummary {
  const cached = repositorySummaryCache.get(checkpoint);
  if (cached?.scope === scope) return cached.summary;
  const repositoryPath = scope.repositoryPath ?? scope.cwd;
  const summary: ThreadCheckpointRepositorySummary = {
    scopeId: scope.id,
    name: scope.label ?? (repositoryPath.split(/[\\/]/).findLast(Boolean) || repositoryPath),
    repositoryPath,
    cwd: scope.cwd,
    status: checkpoint.status,
    files: checkpoint.files,
  };
  repositorySummaryCache.set(checkpoint, { scope, summary });
  return summary;
}

/** Repo checkpoints by run, latest per repo, in the order the repo scopes were created. */
function repositorySummariesByRun(
  projection: Pick<OrchestrationV2ThreadProjection, "checkpoints"> &
    Partial<Pick<OrchestrationV2ThreadProjection, "checkpointScopes">>,
): ReadonlyMap<RunId, ReadonlyArray<ThreadCheckpointRepositorySummary>> | null {
  const scopes = projection.checkpointScopes?.filter((scope) => scope.kind === "repository");
  if (scopes === undefined || scopes.length === 0) return null;
  const scopeById = new Map(scopes.map((scope) => [scope.id, scope]));
  const latestByRun = new Map<RunId, Map<CheckpointScopeId, OrchestrationV2Checkpoint>>();
  for (const checkpoint of projection.checkpoints) {
    if (checkpoint.runId === null || !scopeById.has(checkpoint.scopeId)) continue;
    let latestByScope = latestByRun.get(checkpoint.runId);
    if (latestByScope === undefined) {
      latestByScope = new Map();
      latestByRun.set(checkpoint.runId, latestByScope);
    }
    const previous = latestByScope.get(checkpoint.scopeId);
    if (previous === undefined || previous.ordinalWithinScope < checkpoint.ordinalWithinScope) {
      latestByScope.set(checkpoint.scopeId, checkpoint);
    }
  }
  const byRun = new Map<RunId, ReadonlyArray<ThreadCheckpointRepositorySummary>>();
  for (const [runId, latestByScope] of latestByRun) {
    byRun.set(
      runId,
      scopes.flatMap((scope) => {
        const checkpoint = latestByScope.get(scope.id);
        return checkpoint === undefined ? [] : [repositorySummary(checkpoint, scope)];
      }),
    );
  }
  return byRun;
}

/**
 * One summary per completed app run, from its root checkpoint. Multi-repo threads add the run's
 * tracked repo checkpoints. Without `checkpointScopes`, `repositories` stays empty.
 */
export function deriveThreadCheckpointSummaries(
  projection: Pick<OrchestrationV2ThreadProjection, "checkpoints" | "messages"> &
    Partial<Pick<OrchestrationV2ThreadProjection, "checkpointScopes">>,
): ReadonlyArray<ThreadCheckpointSummary> {
  let assistantMessageIdsByRun: Map<RunId, MessageId | null | undefined> | undefined;
  let nextMessageIndex = -1;
  const repositoriesByRun = repositorySummariesByRun(projection);
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
    const runId = checkpoint.runId;
    const assistantMessageId = assistantMessageIdsByRun.get(runId) ?? null;
    const repositories = repositoriesByRun?.get(runId) ?? EMPTY_REPOSITORIES;
    const cached = summaryCache.get(checkpoint);
    const sameRepositories =
      cached !== undefined && arrayElementsEqual(cached.repositories, repositories);
    if (sameRepositories && cached.assistantMessageId === assistantMessageId) return [cached];
    const summary: ThreadCheckpointSummary = {
      checkpointId: checkpoint.id,
      scopeId: checkpoint.scopeId,
      runId,
      checkpointTurnCount: checkpoint.appRunOrdinal,
      checkpointRef: checkpoint.ref,
      status: checkpoint.status,
      files: checkpoint.files,
      ...(checkpoint.filesTotal === undefined ? {} : { filesTotal: checkpoint.filesTotal }),
      repositories: sameRepositories ? cached.repositories : repositories,
      outsideEdits: checkpoint.outsideEdits ?? EMPTY_OUTSIDE_EDITS,
      assistantMessageId,
      completedAt: DateTime.formatIso(checkpoint.capturedAt),
    };
    summaryCache.set(checkpoint, summary);
    return [summary];
  });
}

export function checkpointFileTotals(
  checkpoint: Pick<ThreadCheckpointSummary, "files" | "filesTotal">,
): OrchestrationV2CheckpointFileTotals {
  if (checkpoint.filesTotal !== undefined) return checkpoint.filesTotal;
  let additions = 0;
  let deletions = 0;
  for (const file of checkpoint.files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { count: checkpoint.files.length, additions, deletions };
}
