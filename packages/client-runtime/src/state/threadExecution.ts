import {
  latestRootProviderFailure,
  latestUnheldRun,
  threadErrorSummary,
  usageLimitRunPresentedAsLatest,
} from "@t3tools/shared/orchestrationV2ThreadError";
import {
  isOrchestrationV2WorkActive,
  isProviderNativeSubagentThread,
  type ModelSelection,
  type OrchestrationV2NotificationSource,
  type OrchestrationV2PendingBackgroundTask,
  type ServerProviderModel,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ThreadProjection,
  orchestrationV2RunWorkStartedAt,
  type ThreadId,
} from "@t3tools/contracts";
import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { getProviderOptionCurrentLabel, getProviderOptionDescriptors } from "@t3tools/shared/model";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";

import {
  threadRuntimeIsActive,
  type ThreadRunSummary,
  type ThreadRuntimeSummary,
} from "./models.ts";
import { formatSubagentDisplayTitle } from "./subagentDisplay.ts";

const ACTIVITY_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);
const INTERRUPTIBLE_RUN_STATUSES = new Set(["preparing", "starting", "running"]);

function latestMatchingRun(
  projection: OrchestrationV2ThreadProjection,
  predicate: (run: OrchestrationV2ThreadProjection["runs"][number]) => boolean,
): OrchestrationV2ThreadProjection["runs"][number] | null {
  return projection.runs.reduce<OrchestrationV2ThreadProjection["runs"][number] | null>(
    (latest, candidate) =>
      predicate(candidate) && (latest === null || candidate.ordinal > latest.ordinal)
        ? candidate
        : latest,
    null,
  );
}

function summarizeThreadRun(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2ThreadProjection["runs"][number],
): ThreadRunSummary {
  return {
    runId: run.id,
    status: run.status,
    requestedAt: DateTime.formatIso(run.requestedAt),
    startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
    assistantMessageId:
      projection.messages.findLast(
        (message) => message.runId === run.id && message.role === "assistant",
      )?.id ?? null,
    ...(run.sourcePlanRef === undefined ? {} : { sourcePlanRef: run.sourcePlanRef }),
  };
}

function presentedUsageLimitRun(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection["runs"][number] | null {
  const providerSession = projection.providerSessions.findLast(
    (session) => session.providerInstanceId === projection.thread.providerInstanceId,
  );
  return usageLimitRunPresentedAsLatest(
    projection.runs,
    projection.turnItems,
    providerSession?.lastError ?? null,
  );
}

/** The run that stands for the thread's outcome when no run is executing. */
function presentedLatestRun(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection["runs"][number] | null {
  return presentedUsageLimitRun(projection) ?? latestUnheldRun(projection.runs);
}

export function deriveLatestThreadRun(
  projection: OrchestrationV2ThreadProjection,
): ThreadRunSummary | null {
  const run = presentedLatestRun(projection);
  return run === null ? null : summarizeThreadRun(projection, run);
}

/**
 * Returns the run that owns live provider work, falling back to the newest run
 * once the thread is idle. A newer queued run must not make an older executing
 * run look settled in clients that render per-run activity.
 */
export function deriveThreadActivityRun(
  projection: OrchestrationV2ThreadProjection,
): ThreadRunSummary | null {
  const run =
    latestMatchingRun(projection, (candidate) => ACTIVITY_RUN_STATUSES.has(candidate.status)) ??
    presentedLatestRun(projection);
  return run === null ? null : summarizeThreadRun(projection, run);
}

/**
 * Provider-native subagent threads never get app runs: their work is a runless
 * root turn whose status follows the subagent. Returns when that work started
 * while it is still active, so clients can show the same working state (and
 * timer) as a run. Stop, queue, and steer stay run-only.
 */
export function deriveRunlessWorkStartedAt(
  projection: OrchestrationV2ThreadProjection,
): string | null {
  const status = deriveProviderSubagentStatus(projection);
  return status !== null && isOrchestrationV2WorkActive(status.status) ? status.startedAt : null;
}

export interface ProviderSubagentStatus {
  readonly status: OrchestrationV2ExecutionNode["status"];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

/**
 * Status of a provider-native subagent thread (see
 * isProviderNativeSubagentThread), read from its runless root turn. Null
 * until that root turn arrives, and for every other thread.
 */
export function deriveProviderSubagentStatus(
  projection: OrchestrationV2ThreadProjection,
): ProviderSubagentStatus | null {
  if (!isProviderNativeSubagentThread(projection.thread)) return null;
  const node = projection.nodes.findLast(
    (candidate) => candidate.kind === "root_turn" && candidate.runId === null,
  );
  if (node === undefined) return null;
  return {
    status: node.status,
    startedAt: node.startedAt === null ? null : DateTime.formatIso(node.startedAt),
    completedAt: node.completedAt === null ? null : DateTime.formatIso(node.completedAt),
  };
}

/** The observed selection belongs to the active provider thread, never a previous handoff. */
export function deriveReportedModelSelection(
  projection: OrchestrationV2ThreadProjection,
): ModelSelection | null {
  const providerThread = projection.providerThreads.find(
    (candidate) =>
      candidate.id === projection.thread.activeProviderThreadId &&
      candidate.providerInstanceId === projection.thread.modelSelection.instanceId,
  );
  return providerThread?.nativeMetadata?.modelSelection ?? null;
}

// Option ids providers use for reasoning effort (Codex, Claude, Grok/ACP, OpenCode).
const REASONING_EFFORT_OPTION_IDS = ["reasoningEffort", "effort", "reasoning", "variant"] as const;

/**
 * The reasoning effort a thread's model runs at, resolved and named the way
 * the composer's effort picker does: the stored choice when valid, else the
 * descriptor's current value, else the model's default. Null when the
 * provider catalog has no effort option for this model (a subagent on a
 * model the catalog does not describe), rather than guessing.
 */
export function formatModelSelectionEffort(
  selection: ModelSelection,
  models: ReadonlyArray<ServerProviderModel> = [],
  reportedSelection?: ModelSelection | null,
): string | null {
  const caps = models.find((model) => model.slug === selection.model)?.capabilities;
  if (!caps) return null;
  const descriptors = getProviderOptionDescriptors({ caps, selections: selection.options });
  for (const id of REASONING_EFFORT_OPTION_IDS) {
    const descriptor = descriptors.find((candidate) => candidate.id === id);
    if (descriptor?.type !== "select") continue;
    const label = getProviderOptionCurrentLabel(descriptor, selection, reportedSelection);
    if (label) return label;
  }
  return null;
}

const SUBAGENT_STATUS_LABELS: Record<OrchestrationV2ExecutionNode["status"], string> = {
  idle: "Idle",
  pending: "Working",
  running: "Working",
  waiting: "Waiting",
  completed: "Completed",
  interrupted: "Interrupted",
  failed: "Failed",
  cancelled: "Cancelled",
  rolled_back: "Cancelled",
};

/**
 * One line for the read-only subagent bar: "Working 12s", "Completed in 34s",
 * or just the status when no duration is known.
 */
export function formatProviderSubagentStatus(
  status: ProviderSubagentStatus | null,
  nowMs: number,
): string {
  if (status === null) return "Starting";
  const label = SUBAGENT_STATUS_LABELS[status.status];
  const live = isOrchestrationV2WorkActive(status.status);
  if (!live && status.status !== "completed") return label;
  const start = status.startedAt === null ? Number.NaN : Date.parse(status.startedAt);
  const end = live
    ? nowMs
    : status.completedAt === null
      ? Number.NaN
      : Date.parse(status.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return label;
  // Whole seconds: a ticking label must not flicker through tenths.
  const elapsed = formatDuration(Math.max(1_000, Math.floor((end - start) / 1_000) * 1_000));
  return live ? `${label} ${elapsed}` : `${label} in ${elapsed}`;
}

export function deriveThreadRuntime(
  projection: OrchestrationV2ThreadProjection,
): ThreadRuntimeSummary | null {
  const latestRun = deriveLatestThreadRun(projection);
  const providerSession = projection.providerSessions.findLast(
    (session) => session.providerInstanceId === projection.thread.providerInstanceId,
  );
  const usageLimitedRun = presentedUsageLimitRun(projection);
  const latestRunProjection = presentedLatestRun(projection);
  const activityRun = deriveThreadActivityRun(projection);
  const liveActivityRun = latestMatchingRun(projection, (run) =>
    ACTIVITY_RUN_STATUSES.has(run.status),
  );
  if (latestRun === null && projection.thread.activeProviderThreadId === null) return null;
  const activeRunId =
    latestMatchingRun(projection, (run) => INTERRUPTIBLE_RUN_STATUSES.has(run.status))?.id ?? null;
  const hasPendingBackgroundTasks =
    derivePendingBackgroundWork({
      latestRun: latestRunProjection,
      providerThreads: projection.providerThreads,
      turnItems: projection.turnItems,
      activeProviderThreadId: projection.thread.activeProviderThreadId,
      runs: projection.runs,
    }).length > 0;
  return {
    status: usageLimitedRun
      ? "failed"
      : hasPendingBackgroundTasks && latestRunProjection?.status !== "failed"
        ? "idle"
        : (activityRun?.status ?? "idle"),
    activeRunId,
    activityStartedAt:
      liveActivityRun === null
        ? null
        : DateTime.formatIso(orchestrationV2RunWorkStartedAt(liveActivityRun)),
    providerInstanceId: projection.thread.providerInstanceId,
    providerName: providerSession?.driver ?? null,
    ...threadErrorSummary(
      latestRootProviderFailure(latestRunProjection, projection.turnItems),
      providerSession?.lastError ?? null,
    ),
    updatedAt: DateTime.formatIso(projection.updatedAt),
  };
}

export function threadRuntimeHasInterruptibleRun(
  runtime: ThreadRuntimeSummary | null | undefined,
): boolean {
  return (
    threadRuntimeIsActive(runtime) &&
    runtime?.activeRunId !== null &&
    runtime?.activeRunId !== undefined
  );
}

type BackgroundWorkKind = OrchestrationV2PendingBackgroundTask["kind"];

// `order` groups work the way a reader thinks about it: agents first, loose tasks last.
const BACKGROUND_WORK_KINDS: Record<
  BackgroundWorkKind,
  { readonly order: number; readonly singular: string; readonly plural: string }
> = {
  subagent: { order: 0, singular: "subagent", plural: "subagents" },
  command: { order: 1, singular: "command", plural: "commands" },
  monitor: { order: 2, singular: "monitor", plural: "monitors" },
  background_task: { order: 3, singular: "background task", plural: "background tasks" },
};

export interface PendingBackgroundWorkItem {
  readonly taskId: string;
  readonly kind: BackgroundWorkKind;
  /** The work's name, or its noun when the provider gave none. */
  readonly label: string;
  /** A subagent's own thread, when it has one. */
  readonly childThreadId: ThreadId | undefined;
}

export interface PendingBackgroundWorkPresentation {
  /**
   * "Waiting on subagent Review src/math.ts", "Waiting on 2 subagents and 1 command",
   * or "Running: Start the dev server" when only commands remain.
   */
  readonly title: string;
  readonly items: ReadonlyArray<PendingBackgroundWorkItem>;
  /**
   * True when the work will wake the agent (subagents, monitors). False when
   * only commands remain, such as a dev server: the agent is done.
   */
  readonly waiting: boolean;
}

function joinWithAnd(parts: ReadonlyArray<string>): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Names what a settled thread still runs, grouped by kind, for the composer strip. */
export function presentPendingBackgroundWork(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
): PendingBackgroundWorkPresentation | null {
  if (tasks.length === 0) return null;
  const waiting = backgroundWorkHoldsCompletion(tasks);
  const items = tasks
    .map((task): PendingBackgroundWorkItem => {
      const description = task.description?.trim();
      const label =
        task.kind === "subagent" && description !== undefined
          ? formatSubagentDisplayTitle(description).trim()
          : description;
      return {
        taskId: task.taskId,
        kind: task.kind,
        label:
          label === undefined || label.length === 0
            ? BACKGROUND_WORK_KINDS[task.kind].singular
            : label,
        childThreadId: task.kind === "subagent" ? task.childThreadId : undefined,
      };
    })
    // `map` returned a new array; Hermes has no `toSorted`.
    .sort(
      (left, right) =>
        BACKGROUND_WORK_KINDS[left.kind].order - BACKGROUND_WORK_KINDS[right.kind].order,
    );
  const [only] = items;
  if (items.length === 1 && only !== undefined) {
    const noun = BACKGROUND_WORK_KINDS[only.kind].singular;
    const named = only.label !== noun;
    const title = waiting
      ? named
        ? `Waiting on ${noun} ${only.label}`
        : `Waiting on a ${noun}`
      : named
        ? `Running: ${only.label}`
        : `Running a ${noun}`;
    return { title, items, waiting };
  }
  const counts = new Map<BackgroundWorkKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const groups = Array.from(counts, ([kind, count]) => {
    const { singular, plural } = BACKGROUND_WORK_KINDS[kind];
    return `${count} ${count === 1 ? singular : plural}`;
  });
  return { title: `${waiting ? "Waiting on" : "Running"} ${joinWithAnd(groups)}`, items, waiting };
}

/** The thread a notification row opens: that of the one subagent or delegated task it reports. */
export function notificationChildThreadId(
  source: OrchestrationV2NotificationSource,
): ThreadId | undefined {
  switch (source.kind) {
    case "subagent":
    case "delegated_task":
      return source.childThreadId;
    case "command":
    case "monitor":
    case "background_task":
      return undefined;
    default:
      source satisfies never;
      return undefined;
  }
}
