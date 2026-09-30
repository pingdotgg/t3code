import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Notification,
  OrchestrationV2NotificationSource,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";

type NotificationOutcome = OrchestrationV2Notification["outcome"];

/** A piece of background work an adapter can name, by kind. */
export type BackgroundWork = {
  /** Subagent title, command, or monitor description. */
  readonly label?: string | undefined;
} & (
  | { readonly kind: "subagent"; readonly childThreadId?: ThreadId | undefined }
  | { readonly kind: "command"; readonly exitCode?: number | undefined }
  | { readonly kind: "monitor" }
  | { readonly kind: "background_task" }
);

/** Background work an adapter saw finish or report, as the user should read it. */
export type BackgroundWorkReport = BackgroundWork & { readonly outcome: NotificationOutcome };

const LABEL_MAX_LENGTH = 80;

function reportLabel(label: string | undefined): string | undefined {
  const firstLine = label?.trim().split("\n")[0]?.trim();
  if (firstLine === undefined || firstLine.length === 0) return undefined;
  return firstLine.length > LABEL_MAX_LENGTH
    ? `${firstLine.slice(0, LABEL_MAX_LENGTH - 1)}…`
    : firstLine;
}

const KIND_NOUN: Record<BackgroundWork["kind"], readonly [string, string]> = {
  subagent: ["Subagent", "subagents"],
  command: ["Command", "commands"],
  monitor: ["Monitor", "monitors"],
  background_task: ["Background task", "background tasks"],
};

function outcomeVerb(kind: BackgroundWork["kind"], outcome: NotificationOutcome) {
  switch (outcome) {
    case "failed":
      return "failed";
    case "cancelled":
      return "was stopped";
    case "updated":
      return kind === "monitor" ? "reported new output" : "updated";
    case "completed":
    case "unknown":
      return "finished";
  }
}

function combinedOutcome(outcomes: ReadonlyArray<NotificationOutcome>): NotificationOutcome {
  if (outcomes.includes("failed")) return "failed";
  if (outcomes.includes("cancelled")) return "cancelled";
  if (outcomes.length > 0 && outcomes.every((outcome) => outcome === "completed")) {
    return "completed";
  }
  return outcomes.includes("updated") ? "updated" : "unknown";
}

function exitSuffix(report: BackgroundWorkReport): string {
  return report.kind === "command" && report.exitCode !== undefined
    ? ` (exit ${report.exitCode})`
    : "";
}

function namedReport(report: BackgroundWorkReport, capitalize: boolean): string {
  const noun = KIND_NOUN[report.kind][0];
  const label = reportLabel(report.label);
  const named = `${capitalize ? noun : noun.toLowerCase()}${label === undefined ? "" : ` "${label}"`}`;
  return `${named}${exitSuffix(report)}`;
}

function joinNames(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function reportsSummary(
  reports: readonly [BackgroundWorkReport, ...ReadonlyArray<BackgroundWorkReport>],
  outcome: NotificationOutcome,
): string {
  const [first] = reports;
  if (reports.length === 1) {
    const label = reportLabel(first.label);
    const noun = KIND_NOUN[first.kind][0];
    return `${noun}${label === undefined ? "" : ` "${label}"`} ${outcomeVerb(first.kind, first.outcome)}${exitSuffix(first)}`;
  }
  const verb =
    outcome === "failed"
      ? "failed"
      : outcome === "cancelled"
        ? "were stopped"
        : outcome === "updated"
          ? "updated"
          : "finished";
  if (reports.length > 3 || reports.every((report) => reportLabel(report.label) === undefined)) {
    const kinds = new Set(reports.map((report) => report.kind));
    const noun = kinds.size === 1 ? KIND_NOUN[first.kind][1] : "background tasks";
    return `${reports.length} ${noun} ${verb}`;
  }
  return `${joinNames(reports.map((report, index) => namedReport(report, index === 0)))} ${verb}`;
}

/** Reports of one kind share it; mixed kinds are generic background work. */
function reportsSource(
  reports: readonly [BackgroundWorkReport, ...ReadonlyArray<BackgroundWorkReport>],
): OrchestrationV2NotificationSource {
  const [first, ...rest] = reports;
  if (rest.some((report) => report.kind !== first.kind)) return { kind: "background_task" };
  switch (first.kind) {
    case "subagent":
      // One subagent is the thing the row opens; several open nothing.
      return rest.length === 0 && first.childThreadId !== undefined
        ? { kind: "subagent", childThreadId: first.childThreadId }
        : { kind: "subagent" };
    case "command":
    case "monitor":
    case "background_task":
      return { kind: first.kind };
  }
}

/**
 * A notification that says which background work a provider reported. Null
 * when nothing is known, so the caller keeps its generic notification.
 */
export function backgroundWorkNotification(
  reports: readonly [BackgroundWorkReport, ...ReadonlyArray<BackgroundWorkReport>],
): OrchestrationV2Notification;
export function backgroundWorkNotification(
  reports: ReadonlyArray<BackgroundWorkReport>,
): OrchestrationV2Notification | null;
export function backgroundWorkNotification(
  reports: ReadonlyArray<BackgroundWorkReport>,
): OrchestrationV2Notification | null {
  const [first, ...rest] = reports;
  if (first === undefined) return null;
  const outcome = combinedOutcome(reports.map((report) => report.outcome));
  return {
    source: reportsSource([first, ...rest]),
    outcome,
    summary: reportsSummary([first, ...rest], outcome),
  };
}

function delegatedTaskReport(
  task: OrchestrationV2Subagent | undefined,
): Extract<BackgroundWorkReport, { readonly kind: "subagent" }> {
  const outcome: NotificationOutcome =
    task?.status === "failed"
      ? "failed"
      : task?.status === "cancelled" || task?.status === "interrupted"
        ? "cancelled"
        : task?.status === "completed"
          ? "completed"
          : "unknown";
  return {
    kind: "subagent",
    // Delegated tasks are titled by their prompt unless the caller named them.
    label: task?.title?.trim() || task?.prompt,
    outcome,
    ...(task?.childThreadId == null ? {} : { childThreadId: task.childThreadId }),
  };
}

/** Summarizes the delegated tasks one completion delivery reports, out of all its parent run delegated. */
function delegatedCompletionNotification(
  completion: NonNullable<OrchestrationV2ConversationMessage["delegatedCompletion"]>,
  tasks: ReadonlyArray<OrchestrationV2Subagent>,
): OrchestrationV2Notification {
  const taskIds = completion.taskIds;
  const reports = taskIds.map((taskId) =>
    delegatedTaskReport(tasks.find((task) => task.id === taskId)),
  );
  const delegatedByRun = tasks.filter(
    (task) => task.origin === "app_owned" && task.runId === completion.parentRunId,
  ).length;
  const outcome = combinedOutcome(reports.map((report) => report.outcome));
  const verb = outcome === "failed" ? "failed" : outcome === "cancelled" ? "stopped" : "finished";
  const [only] = reports;
  if (reports.length === 1 && only !== undefined) {
    const label = reportLabel(only.label);
    return {
      source: {
        kind: "delegated_task",
        taskIds,
        ...(only.childThreadId === undefined ? {} : { childThreadId: only.childThreadId }),
      },
      outcome,
      summary: `Delegated task${label === undefined ? "" : ` "${label}"`} ${verb}`,
    };
  }
  const labels = reports.flatMap((report) => reportLabel(report.label) ?? []);
  const count =
    delegatedByRun > taskIds.length
      ? `${taskIds.length} of ${delegatedByRun}`
      : `${taskIds.length}`;
  return {
    source: { kind: "delegated_task", taskIds },
    outcome,
    summary: `${count} delegated tasks ${verb}${labels.length === 0 ? "" : `: ${labels.join(", ")}`}`,
  };
}

/**
 * What a parent is told when its delegated child pauses on a request: the wake
 * text its agent reads, and the timeline row that opens the child thread.
 */
export function delegatedTaskBlockedWake(
  task: Pick<OrchestrationV2Subagent, "id" | "title" | "prompt">,
  childThreadId: ThreadId,
  request: Pick<OrchestrationV2RuntimeRequest, "id" | "kind">,
): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const label = reportLabel(task.title?.trim() || task.prompt);
  const named = `Delegated task${label === undefined ? "" : ` "${label}"`}`;
  const source = { kind: "delegated_task" as const, taskIds: [task.id], childThreadId };
  if (request.kind === "user_input") {
    return {
      text: `Delegated task ${task.id} is paused on a question. Read it with t3_pending_request_read and answer it with t3_pending_request_respond, using threadId ${childThreadId} and requestId ${request.id}.`,
      notification: { source, outcome: "updated", summary: `${named} is waiting for an answer` },
    };
  }
  return {
    text: `Delegated task ${task.id} is paused: its thread ${childThreadId} is waiting for a person to respond to a ${request.kind} request, and this thread cannot respond to it. Tell the user it needs their approval in that thread, or call task_cancel and delegate again without a narrower runtimeMode. Later approval requests from this task will not wake this thread; its result still will.`,
    notification: { source, outcome: "updated", summary: `${named} is waiting for approval` },
  };
}

/** Keep the delivery message intact while projecting its trigger as an activity. */
export function notificationTurnItem(
  item: OrchestrationV2TurnItem,
  message: Pick<OrchestrationV2ConversationMessage, "notification" | "delegatedCompletion">,
  tasks: ReadonlyArray<OrchestrationV2Subagent>,
): OrchestrationV2TurnItem {
  if (item.type !== "user_message") return item;
  const notification =
    message.delegatedCompletion === undefined
      ? message.notification
      : delegatedCompletionNotification(message.delegatedCompletion, tasks);
  if (notification === undefined) return item;
  const {
    type: _type,
    messageId: _messageId,
    inputIntent: _inputIntent,
    text: _text,
    attachments: _attachments,
    createdBy: _createdBy,
    creationSource: _creationSource,
    scheduledTaskId: _scheduledTaskId,
    ...base
  } = item;
  return { ...base, type: "notification", ...notification };
}
