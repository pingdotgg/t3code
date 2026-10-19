import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RestartCancelledBackgroundWork,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";

type Work = OrchestrationV2RestartCancelledBackgroundWork;
type Attempt = Pick<OrchestrationV2RunAttempt, "id" | "runId">;

const MAX_LABEL_LENGTH = 160;

function compactLabel(value: unknown, maxLength = MAX_LABEL_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replaceAll(/\s+/g, " ").trim();
  if (text.length === 0) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** A bounded label that keeps its id suffix whole whenever it fits. */
function labelWithId(name: unknown, fallback: string, suffix: string): string {
  const budget = MAX_LABEL_LENGTH - suffix.length;
  if (budget < 2) return compactLabel(`${fallback}${suffix}`) ?? fallback;
  return `${compactLabel(name, budget) ?? compactLabel(fallback, budget)}${suffix}`;
}

/**
 * `resumeId` is what the agent resumes a native subagent by, when that is not its
 * item's native id (a Codex subagent resumes by its own provider thread's id).
 */
export function cancelledTurnItemWork(
  item: OrchestrationV2TurnItem,
  resumeId?: string,
): Work | undefined {
  switch (item.type) {
    case "subagent": {
      const nativeId =
        item.origin === "provider_native" ? (resumeId ?? item.nativeItemRef?.nativeId) : undefined;
      return {
        kind: "subagent",
        label: labelWithId(
          compactLabel(item.title) === undefined ? item.prompt : item.title,
          "subagent",
          nativeId === undefined ? "" : ` (id ${nativeId})`,
        ),
        id: item.id,
      };
    }
    case "command_execution":
      return {
        kind: "shell",
        label: compactLabel(item.input) ?? compactLabel(item.title) ?? "background command",
        id: item.id,
      };
    case "dynamic_tool": {
      const monitor =
        item.input !== null &&
        typeof item.input === "object" &&
        Reflect.get(item.input, "persistent") === true;
      return {
        kind: monitor ? "monitor" : "task",
        label: compactLabel(item.title) ?? compactLabel(item.toolName) ?? "background tool",
        id: item.id,
      };
    }
    default:
      return undefined;
  }
}

/**
 * The provider thread waiting on an item's work. A native subagent can run on
 * its own child provider thread (Codex), but the turn that started it awaits it.
 */
export function awaitingProviderThreadId(
  item: OrchestrationV2TurnItem,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "providerThreadId">>,
): OrchestrationV2Run["providerThreadId"] | undefined {
  const runProviderThreadId = runs.find((run) => run.id === item.runId)?.providerThreadId;
  return item.type === "subagent" && item.origin === "provider_native"
    ? (runProviderThreadId ?? item.providerThreadId)
    : (item.providerThreadId ?? runProviderThreadId);
}

function restartWorkKind(task: OrchestrationV2PendingBackgroundTask): Work["kind"] {
  switch (task.kind) {
    case "command":
      return "shell";
    case "subagent":
      return "subagent";
    case "monitor":
      return "monitor";
    case "background_task":
      return "task";
    default:
      task satisfies never;
      return "task";
  }
}

export function cancelledRosterTaskWork(task: OrchestrationV2PendingBackgroundTask): Work {
  if (task.parentTaskId !== undefined) {
    return {
      kind: "subagent",
      label: labelWithId(task.description, "background task", ` (subagent ${task.parentTaskId})`),
      id: task.parentTaskId,
    };
  }
  const kind = restartWorkKind(task);
  const description = compactLabel(task.description);
  return {
    kind,
    label:
      compactLabel(
        description === undefined ? task.taskId : `${description} (id ${task.taskId})`,
      ) ?? "background task",
    id: task.taskId,
  };
}

const MAX_NOTE_ENTRIES = 10;

/**
 * Bounded (entries and label length) so it cannot crowd out the turn's context.
 */
export function restartCancelledBackgroundWorkNote(work: ReadonlyArray<Work>): string {
  const omitted = work.length - MAX_NOTE_ENTRIES;
  return [
    "Note: the T3 server restarted, and this background work was cancelled before it finished. It will not report back on its own, so resume or restart what you still need and wait for its result:",
    ...work.slice(0, MAX_NOTE_ENTRIES).map((entry) => `- ${entry.kind}: ${entry.label}`),
    ...(omitted > 0 ? [`- and ${omitted} more`] : []),
  ].join("\n");
}

type ProviderTurnState = Pick<
  OrchestrationV2ProviderTurn,
  "runAttemptId" | "providerThreadId" | "status"
>;

export function isRestartNoteSource(
  source: Pick<OrchestrationV2Run, "status" | "activeAttemptId" | "restartCancelledBackgroundWork">,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId" | "status">>,
): boolean {
  return (
    // A failed or interrupted turn is never continued. Recovery cancels a
    // waiting run it cannot checkpoint, so a cancelled one still qualifies.
    (source.status === "completed" ||
      source.status === "waiting" ||
      source.status === "cancelled") &&
    (source.restartCancelledBackgroundWork?.length ?? 0) > 0 &&
    !providerTurns.some(
      (turn) => turn.runAttemptId === source.activeAttemptId && turn.status === "cancelled",
    )
  );
}

/**
 * A shell does not wake it: most are dev servers that nobody waits on, so their
 * note waits for the next user message.
 */
export function isAwaitedWork(work: Pick<Work, "kind">): boolean {
  return work.kind !== "shell";
}

export function runOutcome(
  run: Pick<OrchestrationV2Run, "status" | "restartCancelledBackgroundWork">,
): OrchestrationV2Run["status"] {
  return (run.status === "completed" || run.status === "cancelled") &&
    (run.restartCancelledBackgroundWork ?? []).some(isAwaitedWork)
    ? "interrupted"
    : run.status;
}

/**
 * A run that never reached its provider, such as a provider wake the restart
 * cut while it was starting: it lost no work and has no turn to continue. A
 * prepared restart continuation still counts, since it carries its source.
 */
export function neverStarted(
  run: Pick<OrchestrationV2Run, "startedAt" | "restartContinuationOfRunId">,
): boolean {
  return run.startedAt === null && run.restartContinuationOfRunId === undefined;
}

/**
 * A run the restart cancelled before it started, so it supersedes nothing. A
 * run the user stopped before it started still does.
 */
export function cancelledBeforeStart(
  run: Pick<OrchestrationV2Run, "status" | "startedAt" | "restartContinuationOfRunId">,
): boolean {
  return run.status === "cancelled" && neverStarted(run);
}

export function isRestartContinuationSource(
  source: Pick<OrchestrationV2Run, "status" | "activeAttemptId" | "restartCancelledBackgroundWork">,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId" | "status">>,
): boolean {
  return isRestartNoteSource(source, providerTurns)
    ? (source.restartCancelledBackgroundWork ?? []).some(isAwaitedWork)
    : source.status === "cancelled";
}

/**
 * A continuation cut before its provider turn completed may not have delivered
 * its own note: adapters can announce a running turn before accepting the
 * prompt. Carry the note forward until a completed turn proves delivery.
 */
export function restartContinuationNote(
  source: OrchestrationV2Run,
  runs: ReadonlyArray<OrchestrationV2Run>,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId" | "status">>,
  attempts: ReadonlyArray<Attempt>,
): { readonly work: ReadonlyArray<Work>; readonly settled: boolean } {
  const completedAttempts = new Set(
    providerTurns.filter((turn) => turn.status === "completed").map((turn) => turn.runAttemptId),
  );
  const completedRuns = new Set(
    attempts.filter((attempt) => completedAttempts.has(attempt.id)).map((attempt) => attempt.runId),
  );
  let current = source;
  let work = current.restartCancelledBackgroundWork ?? [];
  const visited = new Set([current.id]);
  while (
    current.restartContinuationOfRunId !== undefined &&
    !completedRuns.has(current.id) &&
    !(current.activeAttemptId !== null && completedAttempts.has(current.activeAttemptId))
  ) {
    const previous = runs.find((candidate) => candidate.id === current.restartContinuationOfRunId);
    if (previous === undefined || visited.has(previous.id)) break;
    visited.add(previous.id);
    current = previous;
    work = mergeRestartCancelledBackgroundWork(current.restartCancelledBackgroundWork ?? [], work);
  }
  return { work, settled: isRestartNoteSource(current, providerTurns) };
}

export function isRestartNoteContinuation(
  run: Pick<OrchestrationV2Run, "restartContinuationOfRunId">,
  runs: ReadonlyArray<OrchestrationV2Run>,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId" | "status">>,
  attempts: ReadonlyArray<Attempt>,
): boolean {
  const source =
    run.restartContinuationOfRunId === undefined
      ? undefined
      : runs.find((candidate) => candidate.id === run.restartContinuationOfRunId);
  return (
    source !== undefined &&
    restartContinuationNote(source, runs, providerTurns, attempts).work.length > 0
  );
}

/**
 * A later completed turn on the same provider thread proves delivery, so the
 * pending set is derived rather than cleared. Compactions and resumed turns
 * carry no note, and a rolled-back run left native history, so none of them
 * counts as delivery.
 */
export function pendingRestartCancelledBackgroundWork(input: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly providerTurns: ReadonlyArray<ProviderTurnState>;
  readonly compactionMessageIds: ReadonlySet<string>;
  readonly run: Pick<
    OrchestrationV2Run,
    | "id"
    | "ordinal"
    | "completedAt"
    | "userMessageId"
    | "providerThreadId"
    | "restartContinuationOfRunId"
    | "activeAttemptId"
  >;

  readonly attempts: ReadonlyArray<Attempt>;
}): ReadonlyArray<Work> {
  const isCompaction = (run: typeof input.run) => input.compactionMessageIds.has(run.userMessageId);
  if (
    input.run.providerThreadId === null ||
    input.run.restartContinuationOfRunId !== undefined ||
    isCompaction(input.run)
  )
    return [];
  const providerThreadId = input.run.providerThreadId;
  const deliveredAttemptIds = new Set(
    input.providerTurns
      .filter((turn) => turn.providerThreadId === providerThreadId && turn.status === "completed")
      .map((turn) => turn.runAttemptId),
  );
  const sameThread = input.runs.filter((run) => run.providerThreadId === providerThreadId);
  const prompted = sameThread.filter(
    (candidate) =>
      candidate.id !== input.run.id &&
      candidate.activeAttemptId !== null &&
      candidate.status !== "rolled_back" &&
      (deliveredAttemptIds.has(candidate.activeAttemptId) ||
        input.attempts.some(
          (attempt) => attempt.runId === candidate.id && deliveredAttemptIds.has(attempt.id),
        )) &&
      !isCompaction(candidate) &&
      (candidate.restartContinuationOfRunId === undefined ||
        isRestartNoteContinuation(candidate, input.runs, input.providerTurns, input.attempts)),
  );
  // A steer restarts this run on a new attempt: an earlier attempt that already
  // reached the provider delivered the note, so the replacement must not repeat it.
  const alreadyDelivered = input.attempts.some(
    (attempt) =>
      attempt.runId === input.run.id &&
      attempt.id !== input.run.activeAttemptId &&
      deliveredAttemptIds.has(attempt.id),
  );
  if (alreadyDelivered) return [];
  return sameThread
    .filter(
      (source) =>
        runRanAfter(input.run, source) &&
        (source.restartCancelledBackgroundWork?.length ?? 0) > 0 &&
        !prompted.some((later) => runRanAfter(later, source)),
    )
    .reduce<ReadonlyArray<Work>>(
      (work, source) =>
        mergeRestartCancelledBackgroundWork(work, source.restartCancelledBackgroundWork ?? []),
      [],
    );
}

export function mergeRestartCancelledBackgroundWork(
  current: ReadonlyArray<Work>,
  added: ReadonlyArray<Work>,
): ReadonlyArray<Work> {
  const identity = (entry: Work) => entry.id ?? `${entry.kind}\u0000${entry.label}`;
  const seen = new Set(current.map(identity));
  const merged = [...current];
  for (const entry of added) {
    const key = identity(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}
