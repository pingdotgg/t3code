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
      };
    case "command_execution":
      return {
        kind: "shell",
        label: compactLabel(item.input) ?? compactLabel(item.title) ?? "background command",
      };
    case "dynamic_tool": {
      const monitor =
        item.input !== null &&
        typeof item.input === "object" &&
        Reflect.get(item.input, "persistent") === true;
      return {
        kind: monitor ? "monitor" : "task",
        label: compactLabel(item.title) ?? compactLabel(item.toolName) ?? "background tool",
      };
    }
    default:
      return undefined;
  }
}

/** Describes a provider-reported background task (the provider-thread roster). */
export function cancelledRosterTaskWork(task: OrchestrationV2PendingBackgroundTask): Work {
  const type = task.taskType ?? "";
  const kind =
    type === "local_bash" || type === "command_execution"
      ? "shell"
      : type === "local_agent" || type === "subagent"
        ? "subagent"
        : type.includes("monitor")
          ? "monitor"
          : "task";
  const description = compactLabel(task.description);
  return {
    kind,
    label:
      compactLabel(
        description === undefined ? task.taskId : `${description} (id ${task.taskId})`,
      ) ?? "background task",
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

/**
 * Work cancelled by a restart that the run's provider thread has not been told
 * about yet. The note belongs to the provider thread that lost the work: turns
 * on another provider (after a switch) neither owe it nor deliver it. A later
 * run on the same provider thread delivers it once its attempt reaches the
 * provider, so the pending set is derived rather than cleared. Compactions and
 * restart continuations (which Codex resumes without a prompt) carry no note,
 * and a rolled-back run left native history, so none of them counts as delivery.
 */
export function pendingRestartCancelledBackgroundWork(input: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "runAttemptId" | "providerThreadId">
  >;
  readonly compactionMessageIds: ReadonlySet<string>;
  readonly run: Pick<
    OrchestrationV2Run,
    "id" | "ordinal" | "userMessageId" | "providerThreadId" | "restartContinuationOfRunId"
  >;
}): ReadonlyArray<Work> {
  const carriesNote = (run: typeof input.run) =>
    run.restartContinuationOfRunId === undefined &&
    !input.compactionMessageIds.has(run.userMessageId);
  if (input.run.providerThreadId === null || !carriesNote(input.run)) return [];
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
      carriesNote(candidate),
  );
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
  const seen = new Set(current.map((entry) => `${entry.kind}\u0000${entry.label}`));
  const merged = [...current];
  for (const entry of added) {
    const key = `${entry.kind}\u0000${entry.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}
