import type {
  CommandId,
  OrchestrationV2ProviderTurn,
  RunAttemptId,
  OrchestrationV2Checkpoint,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
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
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}

export function deriveThreadCheckpointSummaries(
  projection: Pick<OrchestrationV2ThreadProjection, "checkpoints" | "messages">,
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
        assistantMessageId,
        completedAt: DateTime.formatIso(checkpoint.capturedAt),
      },
    ];
  });
}

export interface RevertTimelineEntry {
  readonly runId: RunId | null | undefined;
  readonly inherited?: boolean;
  readonly userMessage?: { readonly id: MessageId; readonly inputIntent: string | undefined };
}

// Run ordinals keep increasing after a rewind; only visible local runs define predecessors.
export function deriveRevertTargets(input: {
  readonly entries: ReadonlyArray<RevertTimelineEntry>;
  readonly checkpoints: ReadonlyArray<
    Pick<ThreadCheckpointSummary, "runId" | "checkpointTurnCount" | "status">
  >;
  readonly threadStartCheckpointReady: boolean;
  readonly availableRevertTurnCounts?: ReadonlySet<number> | undefined;
  readonly unsettledRunId?: RunId | null;
}): Map<MessageId, number> {
  const readyByRunId = new Map(
    input.checkpoints
      .filter((checkpoint) => checkpoint.status === "ready")
      .map((checkpoint) => [checkpoint.runId, checkpoint.checkpointTurnCount]),
  );
  const targetByRunId = new Map<RunId, number | undefined>();
  const targets = new Map<MessageId, number>();
  let previousRunId: RunId | null = null;
  for (const entry of input.entries) {
    if (entry.inherited || entry.runId == null) continue;
    const runId = entry.runId;
    if (!targetByRunId.has(runId)) {
      targetByRunId.set(
        runId,
        previousRunId === null
          ? input.threadStartCheckpointReady
            ? 0
            : undefined
          : readyByRunId.get(previousRunId),
      );
      previousRunId = runId;
    }
    const message = entry.userMessage;
    if (!message || runId === input.unsettledRunId) continue;
    if (message.inputIntent !== "turn_start" && message.inputIntent !== "queued_turn") continue;
    const target = targetByRunId.get(runId);
    if (
      target !== undefined &&
      (input.availableRevertTurnCounts === undefined || input.availableRevertTurnCounts.has(target))
    )
      targets.set(message.id, target);
  }
  return targets;
}

export function findRevertCheckpoint(
  checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>,
  turnCount: number,
): OrchestrationV2Checkpoint | undefined {
  return checkpoints.findLast(
    (checkpoint) =>
      checkpoint.status === "ready" &&
      (turnCount === 0
        ? checkpoint.ordinalWithinScope === 0 && checkpoint.appRunOrdinal === null
        : checkpoint.appRunOrdinal === turnCount),
  );
}

export function supportsThreadRollback(
  projection: OrchestrationV2ThreadProjection,
  provider: { readonly supportsConversationRollback?: boolean } | undefined,
): boolean {
  if (!provider || provider.supportsConversationRollback === false) return false;
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === projection.thread.activeProviderThreadId,
  );
  const session =
    projection.providerSessions.find(
      (session) => session.id === providerThread?.providerSessionId,
    ) ??
    projection.providerSessions.findLast(
      (session) => session.providerInstanceId === projection.thread.providerInstanceId,
    );
  return (
    session === undefined ||
    (session.capabilities.threads.canRollbackThread &&
      session.capabilities.checkpointing.providerCanRollbackConversation)
  );
}

export async function waitForThreadRollback({
  readProjection,
  subscribe,
  turnCount,
  requestId,
  revert,
  timeoutMs = 120_000,
}: {
  readonly readProjection: () => OrchestrationV2ThreadProjection | null;
  readonly subscribe: (inspect: () => void) => () => void;
  readonly turnCount: number;
  readonly requestId: CommandId;
  readonly revert: () => Promise<void>;
  readonly timeoutMs?: number;
}): Promise<void> {
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
    throw new Error("The thread has changed. Select a message to rewind again.");
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let accepted = false;
    let unsubscribe = () => {};
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      unsubscribe();
      if (error !== undefined) reject(error);
      else resolve();
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
    // @effect-diagnostics-next-line globalTimers:off - Bounds a client atom subscription outside an Effect runtime.
    timeout = globalThis.setTimeout(() => {
      finish(new Error("Timed out waiting for the thread to rewind."));
    }, timeoutMs);
    Promise.resolve()
      .then(revert)
      .then(() => {
        accepted = true;
        inspect();
      }, finish);
  });
}

export function deriveMessageRevertTargets(
  projection: OrchestrationV2ThreadProjection,
  { historyComplete = false }: { readonly historyComplete?: boolean } = {},
): Map<MessageId, OrchestrationV2Checkpoint> {
  const messagesByRunId = new Map<RunId, Array<{ id: MessageId; inputIntent: string }>>();
  for (const row of projection.visibleTurnItems) {
    if (
      row.visibility === "inherited" ||
      row.item.type !== "user_message" ||
      row.item.runId === null
    )
      continue;
    const messages = messagesByRunId.get(row.item.runId) ?? [];
    messages.push({ id: row.item.messageId, inputIntent: row.item.inputIntent });
    messagesByRunId.set(row.item.runId, messages);
  }
  const runs = projection.runs
    .filter((run) => run.status !== "rolled_back")
    .sort((a, b) => a.ordinal - b.ordinal);
  const rootScopeIds = new Set(
    projection.checkpointScopes
      .filter(
        (scope) =>
          scope.kind === "root_run" && scope.advancesAppRunCount && scope.parentScopeId === null,
      )
      .map((scope) => scope.id),
  );
  const rootCheckpoints = projection.checkpoints.filter((checkpoint) =>
    rootScopeIds.has(checkpoint.scopeId),
  );
  const checkpointsByTurnCount = new Map<number, OrchestrationV2Checkpoint>();
  for (const checkpoint of rootCheckpoints) {
    if (checkpoint.status !== "ready") continue;
    if (checkpoint.appRunOrdinal !== null)
      checkpointsByTurnCount.set(checkpoint.appRunOrdinal, checkpoint);
    else if (checkpoint.ordinalWithinScope === 0) checkpointsByTurnCount.set(0, checkpoint);
  }
  const targets = deriveRevertTargets({
    entries: runs.flatMap((run) => {
      const settled =
        run.status === "completed" ||
        run.status === "interrupted" ||
        run.status === "failed" ||
        run.status === "cancelled";
      const messages = settled
        ? (messagesByRunId.get(run.id) ?? []).map((userMessage) => ({ runId: run.id, userMessage }))
        : [];
      return [{ runId: run.id }, ...messages];
    }),
    checkpoints: rootCheckpoints.flatMap((checkpoint) =>
      checkpoint.runId !== null && checkpoint.appRunOrdinal !== null
        ? [
            {
              runId: checkpoint.runId,
              checkpointTurnCount: checkpoint.appRunOrdinal,
              status: checkpoint.status,
            },
          ]
        : [],
    ),
    // A retained baseline does not prove that the first loaded run is the first surviving run.
    threadStartCheckpointReady:
      checkpointsByTurnCount.has(0) && (historyComplete || runs[0]?.ordinal === 1),
    availableRevertTurnCounts: deriveAvailableRevertTurnCounts(projection),
  });
  const result = new Map<MessageId, OrchestrationV2Checkpoint>();
  for (const [messageId, turnCount] of targets) {
    const checkpoint = checkpointsByTurnCount.get(turnCount);
    if (checkpoint) result.set(messageId, checkpoint);
  }
  return result;
}

/**
 * Run ordinals the conversation can be reverted to: those whose provider turn belongs to the
 * active provider thread, plus 0 for the thread start. Empty without a live provider session
 * on the thread's selected instance.
 */
export function deriveAvailableRevertTurnCounts(
  projection: OrchestrationV2ThreadProjection | null,
) {
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
