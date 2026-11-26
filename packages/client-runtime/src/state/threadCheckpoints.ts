import type {
  CheckpointId,
  CommandId,
  OrchestrationV2Checkpoint,
  OrchestrationV2ProviderTurn,
  OrchestrationV2UserMessageInputIntent,
  RunAttemptId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  OrchestrationV2CheckpointFileTotals,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import type { ThreadStructure } from "./models.ts";
import {
  deriveTurnRepositoryChanges,
  repositoryCheckpointScopeIds,
  type TurnRepositoryChanges,
} from "./threadRepositories.ts";

export interface ThreadCheckpointSummary {
  readonly checkpointId?: CheckpointId;
  readonly scopeId?: CheckpointScopeId;
  readonly runId: RunId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: "ready" | "missing" | "error" | "stale";
  /** A prefix of the changed files when `filesTotal` is set; see `changedFileTotals`. */
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

type RewindVisibility = Pick<
  OrchestrationV2ThreadProjection["visibleTurnItems"][number],
  "visibility"
>;

type RewindTimelineEntry =
  | {
      readonly kind: "message";
      readonly projectedItem?: RewindVisibility | undefined;
      readonly message: {
        readonly id: MessageId;
        readonly role: string;
        readonly runId?: RunId | null | undefined;
        readonly inputIntent?: OrchestrationV2UserMessageInputIntent | undefined;
      };
    }
  | {
      readonly kind: "work";
      readonly entry: {
        readonly itemType?: string | undefined;
        readonly projectedItem?: RewindVisibility | undefined;
        readonly runId?: RunId | null | undefined;
      };
    }
  | { readonly kind: "proposed-plan" | "html-render" | "sent-message" | "mcp-app" | "event" };

// Run ordinals keep increasing after a rewind; only visible local runs define predecessors.
export function deriveRevertTurnCountByUserMessageId(input: {
  readonly timelineEntries: ReadonlyArray<RewindTimelineEntry>;
  readonly checkpoints: ReadonlyArray<ThreadCheckpointSummary>;
  readonly threadStartCheckpointAvailable: boolean;
  readonly availableRevertTurnCounts?: ReadonlySet<number> | undefined;
  readonly unsettledRunId?: RunId | null;
}): Map<MessageId, number> {
  const turnCountByRunId = new Map<RunId, number>();
  for (const checkpoint of input.checkpoints) {
    if (isRewindableCheckpoint(checkpoint)) {
      turnCountByRunId.set(checkpoint.runId, checkpoint.checkpointTurnCount);
    }
  }
  const targetByRunId = new Map<RunId, number | undefined>();
  const byUserMessageId = new Map<MessageId, number>();
  let previousRunId: RunId | null = null;
  for (const entry of input.timelineEntries) {
    // Inherited history belongs to the source thread, not our checkpoint scope.
    if (entry.kind !== "message" && entry.kind !== "work") continue;
    const projectedItem =
      entry.kind === "message" ? entry.projectedItem : entry.entry.projectedItem;
    if (projectedItem?.visibility === "inherited") continue;
    const runId =
      entry.kind === "message"
        ? entry.message.runId
        : entry.entry.itemType === "notification"
          ? entry.entry.runId
          : null;
    if (runId == null) continue;
    if (!targetByRunId.has(runId)) {
      targetByRunId.set(
        runId,
        previousRunId === null
          ? input.threadStartCheckpointAvailable
            ? 0
            : undefined
          : turnCountByRunId.get(previousRunId),
      );
      previousRunId = runId;
    }
    if (entry.kind !== "message") continue;
    const { message } = entry;
    if (message.role !== "user" || message.runId === input.unsettledRunId) continue;
    if (message.inputIntent !== "turn_start" && message.inputIntent !== "queued_turn") continue;
    const target = targetByRunId.get(runId);
    if (
      target !== undefined &&
      (input.availableRevertTurnCounts === undefined || input.availableRevertTurnCounts.has(target))
    )
      byUserMessageId.set(message.id, target);
  }
  return byUserMessageId;
}

// A missing or failed snapshot (no git, a side chat, a capture error) still pins a
// conversation position; only restoring files needs a ready one.
function isRewindableCheckpoint(checkpoint: Pick<OrchestrationV2Checkpoint, "status">) {
  return checkpoint.status !== "stale";
}

export function findRevertCheckpoint(
  projection:
    | Pick<OrchestrationV2ThreadProjection, "checkpoints" | "checkpointScopes">
    | null
    | undefined,
  turnCount: number,
): OrchestrationV2Checkpoint | undefined {
  if (projection == null) return undefined;
  // A tracked repository's baseline also sits at ordinal zero; it is never a rewind target.
  const repositoryScopeIds = repositoryCheckpointScopeIds(projection.checkpointScopes);
  return projection.checkpoints.findLast(
    (checkpoint) =>
      !repositoryScopeIds.has(checkpoint.scopeId) &&
      isRewindableCheckpoint(checkpoint) &&
      (turnCount === 0
        ? checkpoint.ordinalWithinScope === 0 && checkpoint.appRunOrdinal === null
        : checkpoint.appRunOrdinal === turnCount),
  );
}

/**
 * Run ordinals the conversation can be reverted to: those whose provider turn belongs to the
 * active provider thread, plus 0 for the thread start. Empty without a live provider session
 * on the thread's selected instance.
 */
export function deriveAvailableRevertTurnCounts(projection: ThreadStructure | null) {
  const available = new Set<number>();
  const providerThread = projection?.providerThreads.find(
    (candidate) => candidate.id === projection.thread.activeProviderThreadId,
  );
  if (
    !providerThread?.providerSessionId ||
    providerThread.providerInstanceId !== projection?.thread.modelSelection.instanceId
  )
    return available;
  available.add(0);
  const attemptsById = new Map(projection.attempts.map((attempt) => [attempt.id, attempt]));
  const providerTurnsById = new Map<
    OrchestrationV2ProviderTurn["id"],
    OrchestrationV2ProviderTurn
  >();
  const latestTurnByAttempt = new Map<RunAttemptId, OrchestrationV2ProviderTurn>();
  for (const turn of projection.providerTurns) {
    providerTurnsById.set(turn.id, turn);
    if (turn.runAttemptId === null) continue;
    const latest = latestTurnByAttempt.get(turn.runAttemptId);
    if (latest === undefined || turn.ordinal > latest.ordinal) {
      latestTurnByAttempt.set(turn.runAttemptId, turn);
    }
  }
  for (const run of projection.runs) {
    if (run.activeAttemptId === null) continue;
    const attempt = attemptsById.get(run.activeAttemptId);
    const providerTurn =
      latestTurnByAttempt.get(run.activeAttemptId) ??
      (attempt?.providerTurnId == null ? undefined : providerTurnsById.get(attempt.providerTurnId));
    // A ready file checkpoint alone cannot restore the provider conversation.
    if (providerTurn?.providerThreadId === providerThread.id) available.add(run.ordinal);
  }
  return available;
}

export async function waitForRevertedMessage(
  readProjection: () => ThreadStructure | null,
  subscribe: (inspect: () => void) => () => void,
  turnCount: number,
  requestId: CommandId,
  revert: () => Promise<void>,
  timeoutMs = 120_000,
  resolveMessage: MFunctionType = mFallback,
): Promise<ReadonlyArray<string>> {
  const initial = readProjection();
  const providerThreadId = initial?.thread.activeProviderThreadId;
  const initialProviderThread = initial?.providerThreads.find(
    (providerThread) => providerThread.id === providerThreadId,
  );
  const initialProviderThreadIds = new Set(initial?.providerThreads.map((thread) => thread.id));
  // Paging can omit the source run. Rollback commits the entire settled suffix atomically.
  const witness = initial?.runs.reduce<(typeof initial.runs)[number] | undefined>((latest, run) => {
    if (
      run.ordinal <= turnCount ||
      (run.status !== "completed" &&
        run.status !== "interrupted" &&
        run.status !== "failed" &&
        run.status !== "cancelled")
    )
      return latest;
    return latest === undefined || run.ordinal > latest.ordinal ? run : latest;
  }, undefined);
  if (witness === undefined) {
    throw new Error(
      resolveMessage(msg("The thread has changed. Select a message to rewind again.")),
    );
  }
  return new Promise<ReadonlyArray<string>>((resolve, reject) => {
    let settled = false;
    let accepted = false;
    let unsubscribe = () => {};
    let cancelTimeout = () => {};
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      unsubscribe();
      if (error !== undefined) return reject(error);
      const unrestored = readProjection()?.thread.rollbackUnrestored;
      resolve(unrestored?.requestId === requestId ? unrestored.repositories : []);
    };
    const inspect = () => {
      const thread = readProjection();
      if (!thread) return;
      const failure = thread.thread.rollbackFailure;
      if (failure?.requestId === requestId) {
        finish(new Error(failure.message));
        return;
      }
      if (
        accepted &&
        thread.providerThreads.some(
          (providerThread) =>
            (providerThread.id === providerThreadId ||
              // Claude resets to a fresh root session when rewinding to thread start.
              (turnCount === 0 &&
                providerThread.ownerNodeId === null &&
                providerThread.appThreadId === initial?.thread.id &&
                providerThread.providerInstanceId === initialProviderThread?.providerInstanceId &&
                !initialProviderThreadIds.has(providerThread.id))) &&
            providerThread.lastRunOrdinal === (turnCount === 0 ? null : turnCount),
        ) &&
        thread.runs.some((run) => run.id === witness.id && run.status === "rolled_back")
      )
        finish();
    };
    unsubscribe = subscribe(inspect);
    const timeout = Effect.runFork(
      Effect.sleep(timeoutMs).pipe(
        Effect.andThen(
          Effect.sync(() =>
            finish(new Error(resolveMessage(msg("Timed out waiting for the thread to rewind.")))),
          ),
        ),
      ),
    );
    cancelTimeout = () => void Effect.runFork(Fiber.interrupt(timeout));
    Promise.resolve()
      .then(revert)
      .then(() => {
        accepted = true;
        inspect();
      }, finish);
  });
}
