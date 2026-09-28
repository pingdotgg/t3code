import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RestartCancelledBackgroundWork,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

type Work = OrchestrationV2RestartCancelledBackgroundWork;

const MAX_LABEL_LENGTH = 160;

function compactLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replaceAll(/\s+/g, " ").trim();
  if (text.length === 0) return undefined;
  return text.length > MAX_LABEL_LENGTH ? `${text.slice(0, MAX_LABEL_LENGTH - 1)}…` : text;
}

/** Describes a background-capable turn item that restart recovery cancels. */
export function cancelledTurnItemWork(item: OrchestrationV2TurnItem): Work | undefined {
  switch (item.type) {
    case "subagent":
      return {
        kind: "subagent",
        label: compactLabel(item.title) ?? compactLabel(item.prompt) ?? "subagent",
        id: item.id,
      };
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

/** Describes a provider-reported background task (the provider-thread roster). */
export function cancelledRosterTaskWork(task: OrchestrationV2PendingBackgroundTask): Work {
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
 * Provider-facing text for work the model still expects to hear back from.
 * Bounded (entries and label length) so it cannot crowd out the turn's context.
 */
export function restartCancelledBackgroundWorkNote(work: ReadonlyArray<Work>): string {
  const omitted = work.length - MAX_NOTE_ENTRIES;
  return [
    "Note: the T3 server restarted, and this background work was cancelled before it finished. It will not report back:",
    ...work.slice(0, MAX_NOTE_ENTRIES).map((entry) => `- ${entry.kind}: ${entry.label}`),
    ...(omitted > 0 ? [`- and ${omitted} more`] : []),
  ].join("\n");
}

type ProviderTurnState = Pick<
  OrchestrationV2ProviderTurn,
  "runAttemptId" | "providerThreadId" | "status"
>;

/**
 * A run whose turn had settled before the restart cancelled its background
 * work. Continuing it prompts the provider with the note. A run cut mid-turn
 * instead resumes that turn, which Codex does natively without a prompt.
 */
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

/** A restart continuation whose prompt is the note rather than a resume. */
export function isRestartNoteContinuation(
  run: Pick<OrchestrationV2Run, "restartContinuationOfRunId">,
  runs: ReadonlyArray<OrchestrationV2Run>,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId" | "status">>,
): boolean {
  const source =
    run.restartContinuationOfRunId === undefined
      ? undefined
      : runs.find((candidate) => candidate.id === run.restartContinuationOfRunId);
  return source !== undefined && isRestartNoteSource(source, providerTurns);
}

/**
 * Work cancelled by a restart that the run's provider thread has not been told
 * about yet. The note belongs to the provider thread that lost the work: turns
 * on another provider (after a switch) neither owe it nor deliver it. A later
 * run on the same provider thread delivers it once its attempt reaches the
 * provider, so the pending set is derived rather than cleared. Compactions and
 * resumed turns carry no note, and a rolled-back run left native history, so
 * none of them counts as delivery. A note continuation's own prompt is the note.
 */
export function pendingRestartCancelledBackgroundWork(input: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly providerTurns: ReadonlyArray<ProviderTurnState>;
  readonly compactionMessageIds: ReadonlySet<string>;
  readonly run: Pick<
    OrchestrationV2Run,
    | "id"
    | "ordinal"
    | "userMessageId"
    | "providerThreadId"
    | "restartContinuationOfRunId"
    | "activeAttemptId"
  >;
  /** Every attempt id of `run`; a steer replaces the attempt but not the run. */
  readonly runAttemptIds: ReadonlyArray<OrchestrationV2Run["activeAttemptId"] & string>;
}): ReadonlyArray<Work> {
  const isCompaction = (run: typeof input.run) => input.compactionMessageIds.has(run.userMessageId);
  // The current run prepends the note unless it is a compaction or a
  // continuation (whose own prompt is the note, or which resumes natively).
  if (
    input.run.providerThreadId === null ||
    input.run.restartContinuationOfRunId !== undefined ||
    isCompaction(input.run)
  )
    return [];
  const providerThreadId = input.run.providerThreadId;
  const deliveredAttemptIds = new Set(
    input.providerTurns
      .filter((turn) => turn.providerThreadId === providerThreadId)
      .map((turn) => turn.runAttemptId),
  );
  const sameThread = input.runs.filter((run) => run.providerThreadId === providerThreadId);
  const prompted = sameThread.filter(
    (candidate) =>
      candidate.id !== input.run.id &&
      candidate.activeAttemptId !== null &&
      candidate.status !== "rolled_back" &&
      deliveredAttemptIds.has(candidate.activeAttemptId) &&
      !isCompaction(candidate) &&
      (candidate.restartContinuationOfRunId === undefined ||
        isRestartNoteContinuation(candidate, input.runs, input.providerTurns)),
  );
  // A steer restarts this run on a new attempt: an earlier attempt that already
  // reached the provider delivered the note, so the replacement must not repeat it.
  const alreadyDelivered = input.runAttemptIds.some(
    (attemptId) => attemptId !== input.run.activeAttemptId && deliveredAttemptIds.has(attemptId),
  );
  if (alreadyDelivered) return [];
  return sameThread
    .filter(
      (source) =>
        source.ordinal < input.run.ordinal &&
        (source.restartCancelledBackgroundWork?.length ?? 0) > 0 &&
        !prompted.some((later) => later.ordinal > source.ordinal),
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
  // Rows recorded before ids existed fall back to kind + label.
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
