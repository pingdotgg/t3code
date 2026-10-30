import {
  latestRootProviderFailure,
  latestUnheldRun,
  threadErrorSummary,
  usageLimitRunPresentedAsLatest,
} from "@t3tools/shared/orchestrationV2ThreadError";
import {
  isOrchestrationV2WorkActive,
  isProviderNativeSubagentThread,
  latestProviderTurnForAttempt,
  type ModelSelection,
  type OrchestrationV2NotificationSource,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ProviderGoal,
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
import { getProviderOptionCurrentLabel, getProviderOptionStatedValue } from "@t3tools/shared/model";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";

import {
  threadRuntimeIsActive,
  type ThreadRunSummary,
  type ThreadRuntimeSummary,
  type ThreadStructure,
  type ThreadStructureRuntime,
} from "./models.ts";
import { formatSubagentDisplayTitle } from "./subagentDisplay.ts";

const ACTIVITY_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);
const INTERRUPTIBLE_RUN_STATUSES = new Set(["preparing", "starting", "running"]);

function latestMatchingRun(
  projection: ThreadStructure,
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
  projection: ThreadStructure,
  run: OrchestrationV2ThreadProjection["runs"][number],
): ThreadRunSummary {
  const turnStatus = ACTIVITY_RUN_STATUSES.has(run.status)
    ? latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId)?.status
    : undefined;
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
    ...(turnStatus === undefined || turnStatus === "pending" || turnStatus === "running"
      ? {}
      : { turnEnded: true }),
    ...(run.sourcePlanRef === undefined ? {} : { sourcePlanRef: run.sourcePlanRef }),
  };
}

function presentedUsageLimitRun(
  projection: ThreadStructure,
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

function presentedLatestRun(
  projection: ThreadStructure,
): OrchestrationV2ThreadProjection["runs"][number] | null {
  return presentedUsageLimitRun(projection) ?? latestUnheldRun(projection.runs);
}

export function deriveLatestThreadRun(projection: ThreadStructure): ThreadRunSummary | null {
  const run = presentedLatestRun(projection);
  return run === null ? null : summarizeThreadRun(projection, run);
}

export function deriveThreadActivityRun(projection: ThreadStructure): ThreadRunSummary | null {
  const run =
    latestMatchingRun(projection, (candidate) => ACTIVITY_RUN_STATUSES.has(candidate.status)) ??
    presentedLatestRun(projection);
  return run === null ? null : summarizeThreadRun(projection, run);
}

/**
 * Provider-native subagent threads never get app runs: their work is a runless
 * root turn whose status follows the subagent.
 */
export function deriveRunlessWorkStartedAt(projection: ThreadStructure): string | null {
  const status = deriveProviderSubagentStatus(projection);
  return status !== null && isOrchestrationV2WorkActive(status.status) ? status.startedAt : null;
}

export interface ProviderSubagentStatus {
  readonly status: OrchestrationV2ExecutionNode["status"];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export function deriveProviderSubagentStatus(
  projection: ThreadStructure,
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

export function deriveReportedModelSelection(projection: ThreadStructure): ModelSelection | null {
  const providerThread = projection.providerThreads.find(
    (candidate) =>
      candidate.id === projection.thread.activeProviderThreadId &&
      candidate.providerInstanceId === projection.thread.modelSelection.instanceId,
  );
  return providerThread?.nativeMetadata?.modelSelection ?? null;
}

export const REASONING_EFFORT_OPTION_IDS: ReadonlyArray<string> = [
  "reasoningEffort",
  "effort",
  "reasoning",
  "variant",
  "reasoning_effort",
  "thinking_level",
];

export function formatModelSelectionEffort(
  selection: ModelSelection,
  models: ReadonlyArray<ServerProviderModel> = [],
  reportedSelection?: ModelSelection | null,
): string | null {
  const caps = models.find((model) => model.slug === selection.model)?.capabilities;
  if (!caps) return null;
  for (const id of REASONING_EFFORT_OPTION_IDS) {
    const descriptor = caps.optionDescriptors?.find((candidate) => candidate.id === id);
    if (descriptor?.type !== "select") continue;
    const value = getProviderOptionStatedValue(id, selection, reportedSelection);
    if (value === undefined && id !== "variant") continue;
    if (typeof value === "boolean") continue;
    // Bypass picker normalization so an obsolete choice cannot become a catalog default.
    const label = getProviderOptionCurrentLabel(
      { ...descriptor, currentValue: value },
      selection,
      reportedSelection,
    );
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
  const elapsed = formatDuration(Math.max(1_000, Math.floor((end - start) / 1_000) * 1_000));
  return live ? `${label} ${elapsed}` : `${label} in ${elapsed}`;
}

export function deriveThreadRuntime(
  projection: ThreadStructure & Pick<OrchestrationV2ThreadProjection, "updatedAt">,
): ThreadRuntimeSummary | null {
  const runtime = deriveThreadStructureRuntime(projection);
  return runtime === null
    ? null
    : { ...runtime, updatedAt: DateTime.formatIso(projection.updatedAt) };
}

/** The runtime summary a thread's structure determines: all of it but `updatedAt`. */
export function deriveThreadStructureRuntime(
  projection: ThreadStructure,
): ThreadStructureRuntime | null {
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
  const backgroundWorkHoldsRun = backgroundWorkHoldsCompletion(
    derivePendingBackgroundWork({
      latestRun: latestRunProjection,
      providerThreads: projection.providerThreads,
      turnItems: projection.turnItems,
      activeProviderThreadId: projection.thread.activeProviderThreadId,
      runs: projection.runs,
      pullRequests: projection.thread.pullRequests,
    }),
  );
  // A pull request watch can hold a thread that never ran.
  if (
    latestRun === null &&
    projection.thread.activeProviderThreadId === null &&
    !backgroundWorkHoldsRun
  ) {
    return null;
  }
  const activeRunId =
    latestMatchingRun(projection, (run) => INTERRUPTIBLE_RUN_STATUSES.has(run.status))?.id ?? null;
  return {
    status: usageLimitedRun
      ? "failed"
      : backgroundWorkHoldsRun && latestRunProjection?.status !== "failed"
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
  };
}

export function threadRuntimeHasInterruptibleRun(
  runtime: ThreadStructureRuntime | null | undefined,
): boolean {
  return (
    threadRuntimeIsActive(runtime) &&
    runtime?.activeRunId !== null &&
    runtime?.activeRunId !== undefined
  );
}

type BackgroundWorkKind = OrchestrationV2PendingBackgroundTask["kind"];

const BACKGROUND_WORK_KINDS: Record<
  BackgroundWorkKind,
  { readonly order: number; readonly singular: string; readonly plural: string }
> = {
  subagent: { order: 0, singular: "subagent", plural: "subagents" },
  command: { order: 1, singular: "command", plural: "commands" },
  monitor: { order: 2, singular: "monitor", plural: "monitors" },
  background_task: { order: 3, singular: "background task", plural: "background tasks" },
};

export interface RunStopPresentation {
  /** `unresponsive`: the provider did not confirm the stop in time, so Force stop is offered. */
  readonly state: "stopping" | "unresponsive";
  readonly runId: ThreadStructure["runs"][number]["id"];
  readonly requestedAt: string;
  /** The run already ended; the Stop targeted its background work. */
  readonly background: boolean;
}

/**
 * A Stop the provider has not finished yet. It stays `stopping` while the agent winds down,
 * since some providers confirm the request before the turn actually ends. On a run that
 * already ended, only an unanswered Stop of its background work counts.
 */
export function presentRunStop(
  projection: Pick<ThreadStructure, "runs" | "turnItems">,
): RunStopPresentation | null {
  let active: ThreadStructure["runs"][number] | null = null;
  let latest: ThreadStructure["runs"][number] | null = null;
  for (const candidate of projection.runs) {
    // Queued follow-ups never ran, so they hold no Stop of their own.
    if (candidate.status !== "queued" && candidate.ordinal > (latest?.ordinal ?? -1))
      latest = candidate;
    if (
      INTERRUPTIBLE_RUN_STATUSES.has(candidate.status) &&
      candidate.ordinal > (active?.ordinal ?? -1)
    )
      active = candidate;
  }
  const run = active ?? latest;
  if (run === null) return null;
  let request:
    | Extract<ThreadStructure["turnItems"][number], { type: "run_interrupt_request" }>
    | undefined;
  for (const item of projection.turnItems) {
    if (item.runId !== run.id) continue;
    if (item.type === "run_interrupt_result") return null;
    if (item.type === "run_interrupt_request") request = item;
  }
  if (request === undefined || (active === null && request.unresponsiveAt === undefined))
    return null;
  return {
    state: request.unresponsiveAt === undefined ? "stopping" : "unresponsive",
    runId: run.id,
    requestedAt: DateTime.formatIso(request.startedAt ?? request.updatedAt),
    background: active === null,
  };
}

export interface PendingBackgroundWorkItem {
  readonly taskId: string;
  readonly kind: BackgroundWorkKind;
  readonly label: string;
  readonly childThreadId: ThreadId | undefined;
}

export interface PendingBackgroundWorkPresentation {
  readonly title: string;
  readonly items: ReadonlyArray<PendingBackgroundWorkItem>;
  readonly waiting: boolean;
}

function joinWithAnd(parts: ReadonlyArray<string>): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

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
        ? `${only.kind === "monitor" ? "" : `Waiting on ${noun} `}${only.label}`
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

export interface ProviderGoalPresentation {
  readonly title: string;
  readonly objective: string;
  readonly usage: string | null;
  readonly canResume: boolean;
}

const PROVIDER_GOAL_TITLES: Record<OrchestrationV2ProviderGoal["status"], string> = {
  active: "Pursuing goal",
  paused: "Goal paused",
  blocked: "Goal blocked",
  usage_limited: "Goal hit a usage limit",
  budget_limited: "Goal reached its token budget",
  complete: "Goal complete",
};

function formatGoalTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function presentProviderGoal(
  goal: OrchestrationV2ProviderGoal,
  working: boolean,
): ProviderGoalPresentation {
  const usage: Array<string> = [];
  if (goal.tokensUsed !== undefined && goal.tokensUsed > 0) {
    usage.push(
      goal.tokenBudget == null
        ? `${formatGoalTokens(goal.tokensUsed)} tokens`
        : `${formatGoalTokens(goal.tokensUsed)} / ${formatGoalTokens(goal.tokenBudget)} tokens`,
    );
  }
  if (goal.timeUsedSeconds !== undefined && goal.timeUsedSeconds >= 60) {
    usage.push(formatDuration(goal.timeUsedSeconds * 1_000));
  }
  if (goal.checks !== undefined && goal.checks > 0) {
    usage.push(`${goal.checks} ${goal.checks === 1 ? "check" : "checks"}`);
  }
  return {
    title: goal.status === "active" && !working ? "Goal set" : PROVIDER_GOAL_TITLES[goal.status],
    objective: replaceComposerContextReferences(goal.objective, (reference) => reference.label),
    usage: usage.length === 0 ? null : usage.join(" · "),
    canResume: goal.status !== "active" && goal.status !== "complete",
  };
}

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
    case "system":
      return undefined;
    default:
      source satisfies never;
      return undefined;
  }
}
