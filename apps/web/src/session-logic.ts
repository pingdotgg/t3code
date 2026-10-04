import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import {
  extractRuntimeActivityDetail,
  extractWorkLogToolLifecycleStatus,
  mergeWorkLogToolData,
} from "@t3tools/client-runtime/work-log/presentation";
import { hasPendingTurnStart } from "@t3tools/shared/threadBusyState";
import { extractNormalizedChangedFilePathsFromToolPayload } from "@t3tools/shared/toolChangedFiles";
import { extractToolCommandInput } from "@t3tools/shared/toolActivity";
import {
  ApprovalRequestId,
  type ChildThreadLifecycle,
  type CrossThreadSendRecord,
  isToolLifecycleItemType,
  MessageId,
  type OrchestrationLatestTurn,
  type OrchestrationPendingTurnStart,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  ProviderDriverKind,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import {
  isLatestTurnSettled as resolveLatestTurnSettled,
  isThreadActivelyWorking as resolveThreadActivelyWorking,
} from "@t3tools/client-runtime/state/thread-status";
import {
  isChildLifecycleThreadActivity,
  isCrossThreadSendActivity,
  isTurnLifecycleInsightActivity,
} from "@t3tools/shared/orchestrationActivity";

import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  Thread,
  ThreadSession,
  TurnDiffSummary,
} from "./types";

export type ProviderPickerKind = ProviderDriverKind;

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
  /** Shown on the model picker sidebar when relevant */
  pickerSidebarBadge?: "new" | "soon";
}> = [
  { value: ProviderDriverKind.make("codex"), label: "Codex", available: true },
  { value: ProviderDriverKind.make("claudeAgent"), label: "Claude", available: true },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("pi"),
    label: "Pi",
    available: true,
    pickerSidebarBadge: "new",
  },
];

export interface WorkLogEntry {
  childReportId?: string;
  toolLifecycleStatus?: import("@t3tools/client-runtime/work-log/presentation").WorkLogToolLifecycleStatus;
  toolCallId?: string;
  toolData?: unknown;
  turnId?: string;
  requestId?: string;
  id: string;
  sourceActivityKind?: string;
  stableId?: string;
  createdAt: string;
  label: string;
  detail?: string;
  command?: string;
  rawCommand?: string;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  isComplete?: boolean;
  agentRun?: AgentRun;
  action?:
    | {
        kind: "thread";
        label: string;
        threadId: ThreadId;
      }
    | {
        kind: "external";
        label: string;
        url: string;
      };
}

export interface AgentRun {
  taskId: string;
  name: string;
  description?: string;
  agentType?: string;
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed" | "stopped";
  summary?: string;
  entries: WorkLogEntry[];
}

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
  turnId?: string;
}

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: "command" | "file-read" | "file-change";
  createdAt: string;
  detail?: string;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };

export function deriveAgentRunTimelineEntries(agentRun: AgentRun): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  if (agentRun.prompt) {
    entries.push({
      id: `agent-run:${agentRun.taskId}:prompt`,
      kind: "message",
      createdAt: agentRun.startedAt,
      message: {
        id: MessageId.make(`agent-run:${agentRun.taskId}:prompt`),
        role: "user",
        text: agentRun.prompt,
        createdAt: agentRun.startedAt,
        streaming: false,
      },
    });
  }

  entries.push(
    ...agentRun.entries.map((entry) => ({
      id: `agent-run:${agentRun.taskId}:work:${entry.id}`,
      kind: "work" as const,
      createdAt: entry.createdAt,
      entry,
    })),
  );

  if (agentRun.summary) {
    entries.push({
      id: `agent-run:${agentRun.taskId}:summary`,
      kind: "message",
      createdAt: agentRun.completedAt ?? agentRun.entries.at(-1)?.createdAt ?? agentRun.startedAt,
      message: {
        id: MessageId.make(`agent-run:${agentRun.taskId}:summary`),
        role: "assistant",
        text: agentRun.summary,
        createdAt: agentRun.completedAt ?? agentRun.entries.at(-1)?.createdAt ?? agentRun.startedAt,
        completedAt: agentRun.completedAt,
        streaming: false,
      },
    });
  }

  return entries;
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

export function latestValidTimestamp(
  candidates: ReadonlyArray<string | null | undefined>,
): string | undefined {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const candidateMs = Date.parse(candidate);
    if (Number.isFinite(candidateMs) && candidateMs > latestMs) {
      latest = candidate;
      latestMs = candidateMs;
    }
  }
  return latest;
}

type LatestTurnTiming = Pick<OrchestrationLatestTurn, "turnId" | "startedAt" | "completedAt">;
type SessionActivityState = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;

/**
 * Non-failed queued turns mean the thread still has work to do — including the
 * gap between a workspace-handoff turn completing and its continuation starting.
 * Prefer the shell-projected `hasPendingQueuedTurn` flag for sidebar/notify paths.
 */
export function hasActionableQueuedTurn(
  queuedTurns:
    | readonly {
        readonly failedAt: string | null;
        readonly origin?: { readonly kind: string } | undefined;
      }[]
    | null
    | undefined,
): boolean {
  return (queuedTurns ?? []).some(
    (queuedTurn) => queuedTurn.failedAt === null && queuedTurn.origin?.kind !== "child-nudge",
  );
}

export function isThreadActivelyWorking(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  return resolveThreadActivelyWorking({ latestTurn, session });
}

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  return resolveLatestTurnSettled(latestTurn, session);
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  const runningTurnId =
    session?.orchestrationStatus === "running" ? (session.activeTurnId ?? null) : null;
  if (runningTurnId !== null) {
    if (latestTurn?.turnId === runningTurnId) {
      return latestTurn.startedAt ?? sendStartedAt;
    }
    return sendStartedAt;
  }
  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

function requestKindFromRequestType(requestType: unknown): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

function isStalePendingRequestFailureDetail(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("unknown pending user-input request")
  );
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.make(payload.requestId)
        : null;
    const requestKind =
      payload &&
      (payload.requestKind === "command" ||
        payload.requestKind === "file-read" ||
        payload.requestKind === "file-change")
        ? payload.requestKind
        : payload
          ? requestKindFromRequestType(payload.requestType)
          : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
      continue;
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      if (options.length === 0) {
        return null;
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
        multiSelect: question.multiSelect === true,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.make(payload.requestId)
        : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "user-input.requested" && requestId) {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActivePlanState | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const allPlanActivities = ordered.filter((activity) => activity.kind === "turn.plan.updated");
  // Prefer plan from the current turn; fall back to the most recent plan from any turn
  // so that TodoWrite tasks persist across follow-up messages.
  const latest = Option.firstSomeOf([
    ...(latestTurnId
      ? Arr.findLast(allPlanActivities, (activity) => activity.turnId === latestTurnId)
      : Option.none()),
    Arr.last(allPlanActivities),
  ]).pipe(Option.getOrNull);
  if (!latest) {
    return null;
  }
  const payload =
    latest.payload && typeof latest.payload === "object"
      ? (latest.payload as Record<string, unknown>)
      : null;
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps = rawPlan
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.step !== "string") {
        return null;
      }
      const status =
        record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
      return {
        step: record.step,
        status,
      };
    })
    .filter(
      (
        step,
      ): step is {
        step: string;
        status: "pending" | "inProgress" | "completed";
      } => step !== null,
    );
  if (steps.length === 0) {
    return null;
  }
  return {
    createdAt: latest.createdAt,
    turnId: latest.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    steps,
  };
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return toLatestProposedPlanState(matchingTurnPlan);
    }
  }

  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return null;
  }

  return toLatestProposedPlanState(latestPlan);
}

export function findSidebarProposedPlan(input: {
  threads: ReadonlyArray<Pick<Thread, "id" | "proposedPlans">>;
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "sourceProposedPlan"> | null;
  latestTurnSettled: boolean;
  threadId: ThreadId | string | null | undefined;
}): LatestProposedPlanState | null {
  const activeThreadPlans =
    input.threads.find((thread) => thread.id === input.threadId)?.proposedPlans ?? [];

  if (!input.latestTurnSettled) {
    const sourceProposedPlan = input.latestTurn?.sourceProposedPlan;
    if (sourceProposedPlan) {
      const sourcePlan = input.threads
        .find((thread) => thread.id === sourceProposedPlan.threadId)
        ?.proposedPlans.find((plan) => plan.id === sourceProposedPlan.planId);
      if (sourcePlan) {
        return toLatestProposedPlanState(sourcePlan);
      }
    }
  }

  return findLatestProposedPlan(activeThreadPlans, input.latestTurn?.turnId ?? null);
}

export function hasActionableProposedPlan(
  proposedPlan: LatestProposedPlanState | Pick<ProposedPlan, "implementedAt"> | null,
): boolean {
  return proposedPlan !== null && proposedPlan.implementedAt === null;
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): WorkLogEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const agentRuns = deriveAgentRuns(ordered, latestTurnId);
  const agentActivityIds = new Set(agentRuns.flatMap((run) => run.activityIds));
  // Single filter pass: the previous seven chained filters re-scanned the
  // full activity list per predicate on every streaming chunk.
  const entries = ordered
    .filter(
      (activity) =>
        (activity.kind.startsWith("child.lifecycle.")
          ? true
          : latestTurnId
            ? activity.turnId === latestTurnId
            : true) &&
        !agentActivityIds.has(activity.id) &&
        activity.kind !== "tool.started" &&
        activity.kind !== "task.started" &&
        activity.kind !== "context-window.updated" &&
        !isTurnLifecycleInsightActivity(activity) &&
        activity.summary !== "Checkpoint captured" &&
        !isCrossThreadSendActivity(activity) &&
        !isPlanBoundaryToolActivity(activity),
    )
    .map(toDerivedWorkLogEntry);
  const workEntries = collapseDerivedWorkLogEntries(entries).map(
    ({ activityKind: _activityKind, collapseKey: _collapseKey, ...entry }) => entry,
  );
  const activityOrder = new Map<string, number>(
    ordered.map((activity, index) => [activity.id, index]),
  );
  const agentOrder = new Map<string, number | undefined>(
    agentRuns.map((run) => [
      `agent-run:${run.taskId}`,
      activityOrder.get(run.activityIds[0] ?? ""),
    ]),
  );
  return [
    ...workEntries,
    ...agentRuns.map(({ activityIds: _activityIds, ...agentRun }) => ({
      id: `agent-run:${agentRun.taskId}`,
      createdAt: agentRun.startedAt,
      label: agentRun.name,
      tone: agentRun.status === "failed" ? ("error" as const) : ("info" as const),
      isComplete: agentRun.status !== "running",
      agentRun,
    })),
  ].toSorted(
    (left, right) =>
      (activityOrder.get(left.id) ?? agentOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (activityOrder.get(right.id) ?? agentOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

type DerivedAgentRun = AgentRun & { activityIds: string[] };

export function deriveAgentRuns(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): DerivedAgentRun[] {
  const runs = new Map<string, DerivedAgentRun>();
  for (const activity of activities) {
    if (latestTurnId && activity.turnId !== latestTurnId) continue;
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const taskId = typeof payload?.taskId === "string" ? payload.taskId : undefined;
    if (activity.kind === "task.started" && taskId && payload?.taskType === "background-agent") {
      runs.set(taskId, {
        taskId,
        name: typeof payload.name === "string" ? payload.name : activity.summary,
        ...(typeof payload.description === "string" ? { description: payload.description } : {}),
        ...(typeof payload.agentType === "string" ? { agentType: payload.agentType } : {}),
        ...(typeof payload.prompt === "string" ? { prompt: payload.prompt } : {}),
        ...(typeof payload.model === "string" ? { model: payload.model } : {}),
        ...(typeof payload.reasoningEffort === "string"
          ? { reasoningEffort: payload.reasoningEffort }
          : {}),
        status: "running",
        entries: [],
        activityIds: [activity.id],
        startedAt: activity.createdAt,
      });
      continue;
    }
    if (taskId && runs.has(taskId) && activity.kind === "task.completed") {
      const run = runs.get(taskId)!;
      run.status =
        payload?.status === "failed" || payload?.status === "stopped"
          ? payload.status
          : "completed";
      const summary =
        typeof payload?.summary === "string"
          ? payload.summary
          : typeof payload?.detail === "string"
            ? payload.detail
            : undefined;
      if (summary) run.summary = summary;
      run.completedAt = activity.createdAt;
      run.activityIds.push(activity.id);
      continue;
    }
    const data =
      payload?.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : undefined;
    const agentRunId =
      typeof payload?.agentRunId === "string"
        ? payload.agentRunId
        : typeof data?.agentRunId === "string"
          ? data.agentRunId
          : undefined;
    const run = agentRunId ? runs.get(agentRunId) : undefined;
    if (run && activity.kind !== "tool.started") {
      const {
        activityKind: _activityKind,
        collapseKey: _collapseKey,
        ...entry
      } = toDerivedWorkLogEntry(activity);
      run.entries.push(entry);
      run.activityIds.push(activity.id);
    }
  }
  return [...runs.values()];
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:");
}

const CHILD_LIFECYCLE_ACTION_LABELS: Record<ChildThreadLifecycle, string> = {
  started: "View child",
  blocked: "Review child",
  "approval-required": "Review approval",
  "input-required": "Provide input",
  failed: "Review failure",
  completed: "View result",
  "pr-created": "Open pull request",
  reported: "Open child thread",
};

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const commandPreview = extractToolCommand(payload);
  const changedFiles = extractChangedFiles(payload);
  const title = extractToolTitle(payload);
  const isTaskActivity = activity.kind === "task.progress" || activity.kind === "task.completed";
  // Only progress activities carry a short, ticker-sized summary. A completed task keeps its full
  // result in `summary`, so the compact work-log label falls back to the truncated `detail` preview.
  const taskSummary =
    activity.kind === "task.progress" &&
    typeof payload?.summary === "string" &&
    payload.summary.length > 0
      ? payload.summary
      : null;
  const taskDetailAsLabel =
    isTaskActivity &&
    !taskSummary &&
    typeof payload?.detail === "string" &&
    payload.detail.length > 0
      ? payload.detail
      : null;
  const taskLabel = taskSummary || taskDetailAsLabel;
  const isRuntimeActivity =
    activity.kind === "runtime.warning" || activity.kind === "runtime.error";
  const detail = isTaskActivity
    ? !taskDetailAsLabel &&
      payload &&
      typeof payload.detail === "string" &&
      payload.detail.length > 0
      ? stripTrailingExitCode(payload.detail).output
      : null
    : ((isRuntimeActivity ? extractRuntimeActivityDetail(payload) : null) ??
      extractToolDetail(payload, title ?? activity.summary));
  const toolCallId = isTaskActivity ? null : extractToolCallId(payload);
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    sourceActivityKind: activity.kind,
    toolData: payload?.data,
    ...(typeof payload?.requestId === "string" ? { requestId: payload.requestId } : {}),
    createdAt: activity.createdAt,
    label:
      activity.kind === "context-compaction" && activity.summary === "Context compacted"
        ? "Compacted context"
        : taskLabel || activity.summary,
    tone:
      activity.kind === "task.progress"
        ? "thinking"
        : activity.tone === "approval"
          ? "info"
          : activity.tone,
    activityKind: activity.kind,
    isComplete: activity.kind !== "tool.updated" && activity.kind !== "task.progress",
    ...(activity.turnId ? { turnId: activity.turnId } : {}),
  };
  const lifecycleStatus =
    extractWorkLogToolLifecycleStatus(payload) ??
    (activity.kind === "tool.completed"
      ? "completed"
      : activity.kind === "tool.updated" || activity.kind === "tool.started"
        ? "inProgress"
        : undefined);
  if (lifecycleStatus) {
    entry.toolLifecycleStatus = lifecycleStatus;
    entry.isComplete = lifecycleStatus !== "inProgress";
  }
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  const childLifecycleActivity = isChildLifecycleThreadActivity(activity) ? activity : null;
  if (childLifecycleActivity?.payload.report) {
    entry.childReportId = childLifecycleActivity.payload.report.id;
  }
  const externalAction =
    childLifecycleActivity?.payload.lifecycle === "pr-created"
      ? {
          kind: "external" as const,
          label: CHILD_LIFECYCLE_ACTION_LABELS["pr-created"],
          url: childLifecycleActivity.payload.externalAction.url,
        }
      : null;
  const childAction = childLifecycleActivity
    ? {
        kind: "thread" as const,
        label: CHILD_LIFECYCLE_ACTION_LABELS[childLifecycleActivity.payload.lifecycle],
        threadId: childLifecycleActivity.payload.childThreadId,
      }
    : null;
  const action = externalAction ?? childAction;
  if (detail) {
    entry.detail = detail;
  }

  if (commandPreview.command) {
    entry.command = commandPreview.command;
  }
  if (commandPreview.rawCommand) {
    entry.rawCommand = commandPreview.rawCommand;
  }
  if (changedFiles.length > 0) {
    entry.changedFiles = changedFiles;
  }
  if (title) {
    entry.toolTitle = title;
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  if (action) {
    entry.action = action;
  }
  if (toolCallId) {
    entry.toolCallId = toolCallId;
  }
  const stableId = deriveToolLifecycleStableId(entry);
  if (stableId) {
    entry.stableId = stableId;
  }
  const collapseKey = deriveToolLifecycleCollapseKey(entry);
  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }
  return entry;
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  for (const entry of entries) {
    const matchingOpenIndex = findMatchingOpenToolLifecycleEntryIndex(collapsed, entry);
    if (matchingOpenIndex !== -1) {
      const previous = collapsed[matchingOpenIndex];
      if (previous) {
        collapsed.splice(matchingOpenIndex, 1);
        collapsed.push(mergeDerivedWorkLogEntries(previous, entry));
      }
      continue;
    }
    collapsed.push(entry);
  }
  return collapsed;
}

function findMatchingOpenToolLifecycleEntryIndex(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
  next: DerivedWorkLogEntry,
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const previous = entries[index];
    if (previous && shouldCollapseToolLifecycleEntries(previous, next)) {
      return index;
    }
  }
  return -1;
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (previous.activityKind !== "tool.updated" && previous.activityKind !== "tool.completed") {
    return false;
  }
  if (next.activityKind !== "tool.updated" && next.activityKind !== "tool.completed") {
    return false;
  }
  if (previous.activityKind === "tool.completed") {
    return false;
  }
  if (!isSameTurnScope(previous, next)) {
    return false;
  }
  if (previous.collapseKey !== undefined && previous.collapseKey === next.collapseKey) {
    return true;
  }
  return (
    previous.toolCallId !== undefined &&
    next.toolCallId === undefined &&
    previous.itemType === next.itemType &&
    normalizeCompactToolLabel(previous.toolTitle ?? previous.label) ===
      normalizeCompactToolLabel(next.toolTitle ?? next.label)
  );
}

function isSameTurnScope(previous: DerivedWorkLogEntry, next: DerivedWorkLogEntry): boolean {
  return (
    previous.turnId === undefined || next.turnId === undefined || previous.turnId === next.turnId
  );
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const changedFiles = mergeChangedFiles(previous.changedFiles, next.changedFiles);
  const detail = next.detail ?? previous.detail;
  const command = next.command ?? previous.command;
  const rawCommand = next.rawCommand ?? previous.rawCommand;
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const itemType = next.itemType ?? previous.itemType;
  const requestKind = next.requestKind ?? previous.requestKind;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const toolCallId = next.toolCallId ?? previous.toolCallId;
  const stableId = next.stableId ?? previous.stableId;
  const turnId = next.turnId ?? previous.turnId;
  return {
    ...previous,
    ...next,
    toolData: mergeWorkLogToolData(previous.toolData, next.toolData),
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(rawCommand ? { rawCommand } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(stableId ? { stableId } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

function mergeChangedFiles(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): string[] {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return [];
  }
  return [...new Set(merged)];
}

function deriveToolLifecycleCollapseKey(entry: DerivedWorkLogEntry): string | undefined {
  if (entry.activityKind !== "tool.updated" && entry.activityKind !== "tool.completed") {
    return undefined;
  }
  if (entry.stableId) {
    return entry.stableId;
  }
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const detail = entry.detail?.trim() ?? "";
  const itemType = entry.itemType ?? "";
  if (normalizedLabel.length === 0 && detail.length === 0 && itemType.length === 0) {
    return undefined;
  }
  return [entry.turnId ?? "", itemType, normalizedLabel, detail].join("\u001f");
}

function deriveToolLifecycleStableId(entry: DerivedWorkLogEntry): string | undefined {
  if (entry.activityKind !== "tool.updated" && entry.activityKind !== "tool.completed") {
    return undefined;
  }
  if (!entry.toolCallId) {
    return undefined;
  }
  return entry.turnId ? `tool:${entry.turnId}:${entry.toolCallId}` : `tool:${entry.toolCallId}`;
}

function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function toLatestProposedPlanState(proposedPlan: ProposedPlan): LatestProposedPlanState {
  return {
    id: proposedPlan.id,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function trimMatchingOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted.length > 0 ? unquoted : trimmed;
  }
  return trimmed;
}

function executableBasename(value: string): string | null {
  const trimmed = trimMatchingOuterQuotes(value);
  if (trimmed.length === 0) {
    return null;
  }
  const normalized = trimmed.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const last = segments.at(-1)?.trim() ?? "";
  return last.length > 0 ? last.toLowerCase() : null;
}

function splitExecutableAndRest(value: string): { executable: string; rest: string } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed.charAt(0);
    const closeIndex = trimmed.indexOf(quote, 1);
    if (closeIndex <= 0) {
      return null;
    }
    return {
      executable: trimmed.slice(0, closeIndex + 1),
      rest: trimmed.slice(closeIndex + 1).trim(),
    };
  }

  const firstWhitespace = trimmed.search(/\s/);
  if (firstWhitespace < 0) {
    return {
      executable: trimmed,
      rest: "",
    };
  }

  return {
    executable: trimmed.slice(0, firstWhitespace),
    rest: trimmed.slice(firstWhitespace).trim(),
  };
}

const SHELL_WRAPPER_SPECS = [
  {
    executables: ["pwsh", "pwsh.exe", "powershell", "powershell.exe"],
    wrapperFlagPattern: /(?:^|\s)-command\s+/i,
  },
  {
    executables: ["cmd", "cmd.exe"],
    wrapperFlagPattern: /(?:^|\s)\/c\s+/i,
  },
  {
    executables: ["bash", "sh", "zsh"],
    wrapperFlagPattern: /(?:^|\s)-(?:l)?c\s+/i,
  },
] as const;

function findShellWrapperSpec(shell: string) {
  return SHELL_WRAPPER_SPECS.find((spec) =>
    (spec.executables as ReadonlyArray<string>).includes(shell),
  );
}

function unwrapCommandRemainder(value: string, wrapperFlagPattern: RegExp): string | null {
  const match = wrapperFlagPattern.exec(value);
  if (!match) {
    return null;
  }

  const command = value.slice(match.index + match[0].length).trim();
  if (command.length === 0) {
    return null;
  }

  const unwrapped = trimMatchingOuterQuotes(command);
  return unwrapped.length > 0 ? unwrapped : null;
}

function unwrapKnownShellCommandWrapper(value: string): string {
  const split = splitExecutableAndRest(value);
  if (!split || split.rest.length === 0) {
    return value;
  }

  const shell = executableBasename(split.executable);
  if (!shell) {
    return value;
  }

  const spec = findShellWrapperSpec(shell);
  if (!spec) {
    return value;
  }

  return unwrapCommandRemainder(split.rest, spec.wrapperFlagPattern) ?? value;
}

function formatCommandArrayPart(value: string): string {
  return /[\s"'`]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function formatCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null);
  if (parts.length === 0) {
    return null;
  }
  return parts.map((part) => formatCommandArrayPart(part)).join(" ");
}

function normalizeCommandValue(value: unknown): string | null {
  const formatted = formatCommandValue(value);
  return formatted ? unwrapKnownShellCommandWrapper(formatted) : null;
}

function toRawToolCommand(value: unknown, normalizedCommand: string | null): string | null {
  const formatted = formatCommandValue(value);
  if (!formatted || normalizedCommand === null) {
    return null;
  }
  return formatted === normalizedCommand ? null : formatted;
}

function extractToolCommand(payload: Record<string, unknown> | null): {
  command: string | null;
  rawCommand: string | null;
} {
  const candidate = extractToolCommandInput(asRecord(payload?.data) ?? undefined);
  const command = normalizeCommandValue(candidate);
  return {
    command,
    rawCommand: toRawToolCommand(candidate, command),
  };
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

function extractToolCallId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  return asTrimmedString(data?.toolCallId);
}

function normalizeInlinePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateInlinePreview(value: string, maxLength = 84): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizePreviewForComparison(value: string | null | undefined): string | null {
  const normalized = asTrimmedString(value);
  if (!normalized) {
    return null;
  }
  return normalizeCompactToolLabel(normalizeInlinePreview(normalized)).toLowerCase();
}

function summarizeToolTextOutput(value: string): string | null {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => normalizeInlinePreview(line))
    .filter((line) => line.length > 0);
  const firstLine = lines.find((line) => line !== "```");
  if (firstLine) {
    return truncateInlinePreview(firstLine);
  }
  if (lines.length > 1) {
    return `${lines.length.toLocaleString()} lines`;
  }
  return null;
}

function summarizeToolRawOutput(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const rawOutput = asRecord(data?.rawOutput);
  if (!rawOutput) {
    return null;
  }

  const totalFiles = asNumber(rawOutput.totalFiles);
  if (totalFiles !== null) {
    const suffix = rawOutput.truncated === true ? "+" : "";
    return `${totalFiles.toLocaleString()} file${totalFiles === 1 ? "" : "s"}${suffix}`;
  }

  const content = asTrimmedString(rawOutput.content);
  if (content) {
    return summarizeToolTextOutput(content);
  }

  const stdout = asTrimmedString(rawOutput.stdout);
  if (stdout) {
    return summarizeToolTextOutput(stdout);
  }

  return null;
}

function isCommandToolDetail(payload: Record<string, unknown> | null, heading: string): boolean {
  const data = asRecord(payload?.data);
  const kind = asTrimmedString(data?.kind)?.toLowerCase();
  const title = asTrimmedString(payload?.title ?? heading)?.toLowerCase();
  return (
    extractWorkLogItemType(payload) === "command_execution" ||
    kind === "execute" ||
    title === "terminal" ||
    title === "ran command"
  );
}

function extractToolDetail(
  payload: Record<string, unknown> | null,
  heading: string,
): string | null {
  const rawDetail = asTrimmedString(payload?.detail);
  const detail = rawDetail ? stripTrailingExitCode(rawDetail).output : null;
  const normalizedHeading = normalizePreviewForComparison(heading);
  const normalizedDetail = normalizePreviewForComparison(detail);

  if (detail && normalizedHeading !== normalizedDetail) {
    return detail;
  }

  if (isCommandToolDetail(payload, heading)) {
    return null;
  }

  const rawOutputSummary = summarizeToolRawOutput(payload);
  if (rawOutputSummary) {
    const normalizedRawOutputSummary = normalizePreviewForComparison(rawOutputSummary);
    if (normalizedRawOutputSummary !== normalizedHeading) {
      return rawOutputSummary;
    }
  }

  return null;
}

function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): WorkLogEntry["itemType"] | undefined {
  if (typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)) {
    return payload.itemType;
  }
  return undefined;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogEntry["requestKind"] | undefined {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  return extractNormalizedChangedFilePathsFromToolPayload(payload?.data);
}

function compareIsoTimestamps(left: string, right: string): number {
  // ISO-8601 timestamps sort chronologically with ordinal comparison, and it
  // avoids localeCompare's ICU cost inside O(n log n) sort comparators that
  // run on every streaming chunk.
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  const createdAtComparison = compareIsoTimestamps(left.createdAt, right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  const lifecycleRankComparison =
    compareActivityLifecycleRank(left.kind) - compareActivityLifecycleRank(right.kind);
  if (lifecycleRankComparison !== 0) {
    return lifecycleRankComparison;
  }

  return left.id.localeCompare(right.id);
}

function compareActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved") || kind.endsWith(".failed")) {
    return 2;
  }
  return 1;
}

/**
 * Cross-thread sends recorded against the user message that authorized them.
 * These render as a quiet receipt under the message rather than as work-log
 * rows, so they stay out of `deriveWorkLogEntries`.
 */
export function deriveCrossThreadSendsBySourceMessageId(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<MessageId, readonly CrossThreadSendRecord[]> {
  const bySourceMessageId = new Map<MessageId, CrossThreadSendRecord[]>();
  for (const activity of activities) {
    if (!isCrossThreadSendActivity(activity)) continue;
    const record = activity.payload;
    const existing = bySourceMessageId.get(record.sourceMessageId);
    if (existing) {
      existing.push(record);
    } else {
      bySourceMessageId.set(record.sourceMessageId, [record]);
    }
  }
  return bySourceMessageId;
}

export function hasToolActivityForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  return activities.some((activity) => activity.turnId === turnId && activity.tone === "tool");
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  proposedPlans: ProposedPlan[],
  workEntries: WorkLogEntry[],
): TimelineEntry[] {
  const messageOrderById = new Map(messages.map((message, index) => [message.id, index]));
  const deliveredChildReportIds = new Set(
    messages.flatMap((message) =>
      message.origin?.kind === "child-nudge"
        ? message.origin.updates.map((report) => report.id)
        : [],
    ),
  );
  const messageRows: TimelineEntry[] = messages.map((message) => ({
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message,
  }));
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  const workRows: TimelineEntry[] = workEntries
    .filter((entry) => !entry.childReportId || !deliveredChildReportIds.has(entry.childReportId))
    .map((entry) => ({
      id: entry.stableId ?? entry.id,
      kind: "work",
      createdAt: entry.createdAt,
      entry,
    }));
  return [...messageRows, ...proposedPlanRows, ...workRows].toSorted((a, b) => {
    if (a.kind === "message" && b.kind === "message") {
      return (messageOrderById.get(a.message.id) ?? 0) - (messageOrderById.get(b.message.id) ?? 0);
    }
    return compareIsoTimestamps(a.createdAt, b.createdAt);
  });
}

export function deriveCompletionDividerBeforeEntryId(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  latestTurn: Pick<
    OrchestrationLatestTurn,
    "assistantMessageId" | "startedAt" | "completedAt"
  > | null,
): string | null {
  if (!latestTurn?.startedAt || !latestTurn.completedAt) {
    return null;
  }

  if (latestTurn.assistantMessageId) {
    const exactMatch = timelineEntries.find(
      (timelineEntry) =>
        timelineEntry.kind === "message" &&
        timelineEntry.message.role === "assistant" &&
        timelineEntry.message.id === latestTurn.assistantMessageId,
    );
    if (exactMatch) {
      return exactMatch.id;
    }
  }

  const turnStartedAt = Date.parse(latestTurn.startedAt);
  const turnCompletedAt = Date.parse(latestTurn.completedAt);
  if (Number.isNaN(turnStartedAt) || Number.isNaN(turnCompletedAt)) {
    return null;
  }

  let inRangeMatch: string | null = null;
  let fallbackMatch: string | null = null;
  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message" || timelineEntry.message.role !== "assistant") {
      continue;
    }
    const messageAt = Date.parse(timelineEntry.message.createdAt);
    if (Number.isNaN(messageAt) || messageAt < turnStartedAt) {
      continue;
    }
    fallbackMatch = timelineEntry.id;
    if (messageAt <= turnCompletedAt) {
      inRangeMatch = timelineEntry.id;
    }
  }
  return inRangeMatch ?? fallbackMatch;
}

export function inferCheckpointTurnCountByTurnId(
  summaries: TurnDiffSummary[],
): Record<TurnId, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<TurnId, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

/** Delegates to the shared derivation so this cannot drift from the invariant. */
export function derivePhase(
  session: ThreadSession | null,
  pendingTurnStart?: OrchestrationPendingTurnStart | null,
): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  if (hasPendingTurnStart(pendingTurnStart)) {
    return "running";
  }
  return "ready";
}
