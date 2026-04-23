import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  type ProviderKind,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  type ThreadId,
  type TurnId,
} from "@marcode/contracts";

import { type InlineDiffHunk, extractDiffPreviews, mergeDiffPreviews } from "./lib/inlineDiff";

import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  Thread,
  ThreadSession,
  TurnDiffSummary,
} from "./types";

export type ProviderPickerKind = ProviderKind;

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
  /** Shown on the model picker sidebar when relevant */
  pickerSidebarBadge?: "new" | "soon";
}> = [
  { value: "claudeAgent", label: "Claude", available: true },
  { value: "codex", label: "Codex", available: true },
  { value: "opencode", label: "OpenCode", available: true },
  { value: "cursor", label: "Cursor", available: true },
];

export interface SubagentToolProgress {
  readonly toolName: string;
  readonly elapsedSeconds: number | null;
  readonly createdAt: string;
}

export interface AgentProgressEntry {
  readonly lastToolName: string | null;
  readonly description: string | null;
  readonly summary: string | null;
  readonly createdAt: string;
}

export interface AgentTaskSummary {
  taskId: string;
  agentType: string | null;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  toolUses: number | null;
  totalTokens: number | null;
  lastToolName: string | null;
  progressSummary: string | null;
  createdAt: string;
  toolUseId: string | null;
  prompt: string | null;
  response: string | null;
  model: string | null;
  toolProgressEntries: ReadonlyArray<SubagentToolProgress>;
  progressHistory: ReadonlyArray<AgentProgressEntry>;
}

export interface AgentGroup {
  tasks: ReadonlyArray<AgentTaskSummary>;
}

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  label: string;
  detail?: string;
  command?: string;
  rawCommand?: string;
  exitCode?: number;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolCompleted?: boolean;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  diffPreviews?: ReadonlyArray<InlineDiffHunk>;
  agentGroup?: AgentGroup;
  itemId?: string;
}

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
  toolCallId?: string;
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

type LatestTurnTiming = Pick<OrchestrationLatestTurn, "turnId" | "startedAt" | "completedAt">;
type SessionActivityState = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  if (session.orchestrationStatus === "running") return false;
  return true;
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
      const multiSelect =
        typeof question.multiSelect === "boolean" ? question.multiSelect : undefined;
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
        multiSelect,
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
  options?: { isSessionRunning?: boolean },
): WorkLogEntry[] {
  const isSessionRunning = options?.isSessionRunning ?? false;
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  const collabToolDataByItemId = new Map<string, SubagentCollabToolData>();
  const collabToolDataUnkeyed: SubagentCollabToolData[] = [];
  const collabToolItemIds = new Set<string>();
  for (const activity of ordered) {
    if (latestTurnId && activity.turnId !== latestTurnId) continue;
    if (activity.kind === "tool.started") {
      const payload = asRecord(activity.payload);
      if (payload?.itemType === "collab_agent_tool_call") {
        const itemId = asTrimmedString(payload?.itemId);
        if (itemId) collabToolItemIds.add(itemId);
      }
      continue;
    }
    if (!isSubagentToolActivity(activity)) continue;
    const payload = asRecord(activity.payload);
    const itemId = asTrimmedString(payload?.itemId);
    if (itemId) collabToolItemIds.add(itemId);
    const data = asRecord(payload?.data);
    if (!data) continue;
    const input = asRecord(data.input);
    const prompt = asTrimmedString(input?.prompt) ?? null;
    const response = extractCollabToolResponse(data.result);
    const entry: SubagentCollabToolData = { prompt, response };
    if (itemId) {
      collabToolDataByItemId.set(itemId, entry);
    } else {
      collabToolDataUnkeyed.push(entry);
    }
  }

  const nestedTaskIds = new Set<string>();
  for (const activity of ordered) {
    if (activity.kind !== "task.started") continue;
    if (latestTurnId && activity.turnId !== latestTurnId) continue;
    const payload = asRecord(activity.payload);
    const taskId = asTrimmedString(payload?.taskId);
    if (!taskId) continue;
    const toolUseId = asTrimmedString(payload?.toolUseId);
    if (toolUseId && !collabToolItemIds.has(toolUseId)) {
      nestedTaskIds.add(taskId);
    }
  }

  const filtered = ordered
    .filter((activity) => (latestTurnId ? activity.turnId === latestTurnId : true))
    .filter(
      (activity) =>
        activity.kind !== "tool.started" ||
        (activityHasItemType(activity, "command_execution") && activityHasItemId(activity)),
    )
    .filter((activity) => activity.kind !== "context-window.updated")
    .filter((activity) => activity.summary !== "Checkpoint captured")
    .filter((activity) => !isPlanBoundaryToolActivity(activity))
    .filter((activity) => !isSubagentToolActivity(activity))
    .filter((activity) => !isTodoWriteToolActivity(activity))
    .filter((activity) => {
      const taskId = extractTaskId(activity);
      return !taskId || !nestedTaskIds.has(taskId);
    })
    .filter((activity) => !activity.kind.startsWith("setup-script."))
    .filter((activity) => !activity.kind.startsWith("approval."));

  const taskCompletionTime = new Map<string, string>();
  for (const activity of filtered) {
    if (activity.kind === "task.completed") {
      const tid = extractTaskId(activity);
      if (tid) taskCompletionTime.set(tid, activity.createdAt);
    }
  }

  const taskLaunchGroup = new Map<string, number>();
  let groupIndex = -1;
  let needsNewGroup = true;
  const pendingTaskIds = new Set<string>();

  for (const activity of filtered) {
    if (activity.kind === "tool.progress") continue;
    if (!isTaskActivity(activity)) {
      needsNewGroup = true;
      continue;
    }
    const taskId = extractTaskId(activity);
    if (!taskId) continue;

    if (activity.kind === "task.completed" && pendingTaskIds.has(taskId)) {
      pendingTaskIds.delete(taskId);
      needsNewGroup = true;
    }

    if (taskLaunchGroup.has(taskId)) continue;

    if (!needsNewGroup) {
      for (const pendingId of pendingTaskIds) {
        const completedAt = taskCompletionTime.get(pendingId);
        if (completedAt && completedAt <= activity.createdAt) {
          needsNewGroup = true;
          pendingTaskIds.delete(pendingId);
        }
      }
    }

    if (needsNewGroup) {
      groupIndex++;
      needsNewGroup = false;
    }
    taskLaunchGroup.set(taskId, groupIndex);
    pendingTaskIds.add(taskId);
  }

  const groupActivities = new Map<number, OrchestrationThreadActivity[]>();
  const taskActivityIds = new Set<string>();

  for (const activity of filtered) {
    if (!isTaskActivity(activity)) continue;
    const taskId = extractTaskId(activity);
    if (!taskId) continue;
    const gIdx = taskLaunchGroup.get(taskId);
    if (gIdx === undefined) continue;
    taskActivityIds.add(activity.id);
    let arr = groupActivities.get(gIdx);
    if (!arr) {
      arr = [];
      groupActivities.set(gIdx, arr);
    }
    arr.push(activity);
  }

  const emittedGroups = new Set<number>();
  const entries: DerivedWorkLogEntry[] = [];

  for (const activity of filtered) {
    if (taskActivityIds.has(activity.id)) {
      const taskId = extractTaskId(activity);
      const gIdx = taskId !== null ? taskLaunchGroup.get(taskId) : undefined;
      if (gIdx !== undefined && !emittedGroups.has(gIdx)) {
        emittedGroups.add(gIdx);
        const waveActivities = groupActivities.get(gIdx) ?? [];
        const taskGroups = buildTaskGroups(waveActivities);
        const groupEntry = buildAgentGroupEntry(
          activity,
          taskGroups,
          collabToolDataByItemId,
          collabToolDataUnkeyed,
          isSessionRunning,
        );
        if (groupEntry) entries.push(groupEntry);
      }
      continue;
    }
    if (activity.kind === "tool.progress") continue;
    entries.push(toDerivedWorkLogEntry(activity));
  }

  return deduplicateToolLifecycleEntries(collapseDerivedWorkLogEntries(entries)).map(
    ({ activityKind: _activityKind, collapseKey: _collapseKey, ...entry }) => entry,
  );
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

function isSubagentToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.completed" && activity.kind !== "tool.updated") {
    return false;
  }
  const payload = asRecord(activity.payload);
  return payload?.itemType === "collab_agent_tool_call";
}

function isTodoWriteToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (
    activity.kind !== "tool.started" &&
    activity.kind !== "tool.updated" &&
    activity.kind !== "tool.completed"
  ) {
    return false;
  }
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  const toolName = typeof data?.toolName === "string" ? data.toolName : undefined;
  return typeof toolName === "string" && toolName.toLowerCase().includes("todowrite");
}

interface TaskActivityGroup {
  started: OrchestrationThreadActivity | null;
  progressEntries: OrchestrationThreadActivity[];
  completed: OrchestrationThreadActivity | null;
  toolProgressEntries: OrchestrationThreadActivity[];
  activityIds: string[];
}

const TASK_ACTIVITY_KINDS = new Set([
  "task.started",
  "task.progress",
  "task.completed",
  "tool.progress",
]);

function isTaskActivity(activity: OrchestrationThreadActivity): boolean {
  return TASK_ACTIVITY_KINDS.has(activity.kind);
}

function extractTaskId(activity: OrchestrationThreadActivity): string | null {
  const payload = asRecord(activity.payload);
  const taskId = payload?.taskId;
  return typeof taskId === "string" && taskId.length > 0 ? taskId : null;
}

function buildTaskGroups(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Map<string, TaskActivityGroup> {
  const groups = new Map<string, TaskActivityGroup>();
  for (const activity of activities) {
    if (!isTaskActivity(activity)) continue;
    const taskId = extractTaskId(activity);
    if (!taskId) continue;

    let group = groups.get(taskId);
    if (!group) {
      group = {
        started: null,
        progressEntries: [],
        completed: null,
        toolProgressEntries: [],
        activityIds: [],
      };
      groups.set(taskId, group);
    }
    group.activityIds.push(activity.id);

    if (activity.kind === "task.started") group.started = activity;
    else if (activity.kind === "task.progress") group.progressEntries.push(activity);
    else if (activity.kind === "task.completed") group.completed = activity;
    else if (activity.kind === "tool.progress") group.toolProgressEntries.push(activity);
  }
  return groups;
}

function extractTaskUsage(payload: Record<string, unknown> | null): {
  totalTokens: number | null;
  toolUses: number | null;
} {
  const usage = asRecord(payload?.usage);
  if (!usage) return { totalTokens: null, toolUses: null };
  return {
    totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : null,
    toolUses: typeof usage.tool_uses === "number" ? usage.tool_uses : null,
  };
}

interface SubagentCollabToolData {
  prompt: string | null;
  response: string | null;
}

function extractCollabToolResponse(resultRaw: unknown): string | null {
  if (typeof resultRaw === "string") return resultRaw;
  const record = asRecord(resultRaw);
  if (!record) return null;
  const content = record.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      const b = asRecord(block);
      if (b && typeof b.text === "string") texts.push(b.text);
    }
    return texts.length > 0 ? texts.join("\n") : null;
  }
  const text = asTrimmedString(record.text);
  if (text) return text;
  return null;
}

function buildAgentTaskSummary(
  taskId: string,
  group: TaskActivityGroup,
  collabToolDataByItemId: ReadonlyMap<string, SubagentCollabToolData>,
  collabToolDataUnkeyed: ReadonlyArray<SubagentCollabToolData>,
  isSessionRunning: boolean,
): AgentTaskSummary {
  const completedPayload = asRecord(group.completed?.payload);
  const latestProgress = group.progressEntries.at(-1);
  const latestProgressPayload = asRecord(latestProgress?.payload);
  const startedPayload = asRecord(group.started?.payload);

  const description = group.started
    ? (asTrimmedString(startedPayload?.detail) ??
      asTrimmedString(startedPayload?.description) ??
      asTrimmedString(startedPayload?.summary) ??
      "Agent")
    : (asTrimmedString(latestProgressPayload?.detail) ??
      asTrimmedString(latestProgressPayload?.summary) ??
      "Agent");

  const agentType = asTrimmedString(startedPayload?.agentType) ?? null;

  let status: AgentTaskSummary["status"] = "running";
  if (completedPayload) {
    const rawStatus = completedPayload.status;
    if (rawStatus === "failed") status = "failed";
    else if (rawStatus === "stopped") status = "stopped";
    else status = "completed";
  } else if (!isSessionRunning) {
    status = "completed";
  }

  const usageSource = completedPayload ?? latestProgressPayload;
  const { totalTokens, toolUses } = extractTaskUsage(usageSource);

  const lastToolName = asTrimmedString(latestProgressPayload?.lastToolName) ?? null;
  const progressSummary =
    asTrimmedString(latestProgressPayload?.detail) ??
    asTrimmedString(latestProgressPayload?.summary) ??
    null;

  const createdAt =
    group.started?.createdAt ?? latestProgress?.createdAt ?? group.completed?.createdAt ?? "";

  const toolUseId = asTrimmedString(startedPayload?.toolUseId) ?? null;
  const startedPrompt = asTrimmedString(startedPayload?.prompt) ?? null;
  const collabData = toolUseId
    ? collabToolDataByItemId.get(toolUseId)
    : (collabToolDataUnkeyed.find(
        (d) => d.prompt !== null && startedPrompt !== null && d.prompt === startedPrompt,
      ) ?? (collabToolDataUnkeyed.length === 1 ? collabToolDataUnkeyed[0] : undefined));

  const prompt = startedPrompt ?? collabData?.prompt ?? null;

  const completedDetail = asTrimmedString(completedPayload?.detail);
  const completedSummary = asTrimmedString(completedPayload?.summary);
  const rawResponse = collabData?.response ?? completedDetail ?? completedSummary ?? null;
  const response = rawResponse === description ? null : rawResponse;

  const model = asTrimmedString(startedPayload?.model) ?? null;

  const toolProgressEntries: SubagentToolProgress[] = group.toolProgressEntries.map((activity) => {
    const p = asRecord(activity.payload);
    return {
      toolName: asTrimmedString(p?.toolName) ?? "Tool",
      elapsedSeconds: typeof p?.elapsedSeconds === "number" ? p.elapsedSeconds : null,
      createdAt: activity.createdAt,
    };
  });

  const progressHistory: AgentProgressEntry[] = group.progressEntries.map((activity) => {
    const p = asRecord(activity.payload);
    return {
      lastToolName: asTrimmedString(p?.lastToolName) ?? null,
      description: asTrimmedString(p?.detail) ?? null,
      summary: asTrimmedString(p?.summary) ?? null,
      createdAt: activity.createdAt,
    };
  });

  return {
    taskId,
    agentType,
    description,
    status,
    toolUses,
    totalTokens,
    lastToolName,
    progressSummary,
    createdAt,
    toolUseId,
    prompt,
    response,
    model,
    toolProgressEntries,
    progressHistory,
  };
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return `${tokens} tokens`;
  if (tokens < 100_000) return `${(tokens / 1_000).toFixed(1)}k tokens`;
  return `${Math.round(tokens / 1_000)}k tokens`;
}

export function formatToolUseCount(count: number): string {
  return `${count} tool use${count !== 1 ? "s" : ""}`;
}

function buildAgentGroupLabel(tasks: ReadonlyArray<AgentTaskSummary>): string {
  const total = tasks.length;
  const runningCount = tasks.filter((t) => t.status === "running").length;
  const failedCount = tasks.filter((t) => t.status === "failed").length;
  const parallel = total > 1 ? "parallel " : "";
  const noun = total === 1 ? "agent" : "agents";

  if (runningCount > 0) {
    if (runningCount === total) return `${total} ${parallel}${noun} running`;
    return `${total} ${parallel}${noun} (${runningCount} running)`;
  }
  if (failedCount > 0) {
    return `${total} ${parallel}${noun} finished (${failedCount} failed)`;
  }
  return `${total} ${parallel}${noun} finished`;
}

function buildAgentGroupEntry(
  firstActivity: OrchestrationThreadActivity,
  taskGroups: Map<string, TaskActivityGroup>,
  collabToolDataByItemId: ReadonlyMap<string, SubagentCollabToolData>,
  collabToolDataUnkeyed: ReadonlyArray<SubagentCollabToolData>,
  isSessionRunning: boolean,
): DerivedWorkLogEntry | null {
  if (taskGroups.size === 0) return null;

  const tasks = [...taskGroups.entries()].map(([taskId, group]) =>
    buildAgentTaskSummary(
      taskId,
      group,
      collabToolDataByItemId,
      collabToolDataUnkeyed,
      isSessionRunning,
    ),
  );
  const hasFailed = tasks.some((t) => t.status === "failed");

  return {
    id: `agent-group:${firstActivity.id}`,
    createdAt: firstActivity.createdAt,
    label: buildAgentGroupLabel(tasks),
    tone: hasFailed ? "error" : "info",
    activityKind: "task.started",
    agentGroup: { tasks },
  };
}

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const commandPreview = extractToolCommand(payload);
  const changedFiles = extractChangedFiles(payload);
  const title = extractToolTitle(payload);
  const isTaskActivity = activity.kind === "task.progress" || activity.kind === "task.completed";
  const toolCallId = isTaskActivity ? null : extractToolCallId(payload);
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    label: activity.summary,
    tone: activity.tone === "approval" ? "info" : activity.tone,
    activityKind: activity.kind,
    ...(activity.kind === "tool.completed" ? { toolCompleted: true } : {}),
  };
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  const resultText = extractToolResultText(payload);
  if (resultText) {
    const { output, exitCode } = stripTrailingExitCode(resultText);
    if (output) {
      entry.detail = output;
    }
    if (exitCode !== undefined) {
      entry.exitCode = exitCode;
    }
  }
  if (!entry.detail) {
    // Use the smart extractor: suppresses detail when it's equivalent to the
    // row heading (prevents echoing "Read File" as both title and detail),
    // and falls back to a summary of `data.rawOutput` (e.g. grep's
    // `{totalFiles: 19}` → "19 files", read's `{content: "..."}` → first line).
    const smartDetail = extractToolDetail(payload, title ?? activity.summary);
    if (smartDetail !== null) {
      entry.detail = smartDetail;
    }
  }
  // Regardless of which detail source we used, extract the exit code from the
  // raw payload detail so CommandExecutionCard can badge failure/success.
  if (entry.exitCode === undefined && payload && typeof payload.detail === "string") {
    const { exitCode } = stripTrailingExitCode(payload.detail);
    if (exitCode !== undefined) {
      entry.exitCode = exitCode;
    }
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
  const toolName = extractToolName(payload);
  const toolInput = extractToolInput(payload);
  if (title) {
    entry.toolTitle = title;
  }
  if (toolName) {
    entry.toolName = toolName;
  }
  if (toolInput) {
    entry.toolInput = toolInput;
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  if (payload && typeof payload.itemId === "string" && payload.itemId.length > 0) {
    entry.itemId = payload.itemId;
  }
  if (toolCallId) {
    entry.toolCallId = toolCallId;
  }
  const diffPreviews = extractDiffPreviews(payload);
  if (diffPreviews.length > 0) {
    entry.diffPreviews = diffPreviews;
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
    const previous = collapsed.at(-1);
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      collapsed[collapsed.length - 1] = mergeDerivedWorkLogEntries(previous, entry);
      continue;
    }
    collapsed.push(entry);
  }
  return collapsed;
}

function toolDeduplicationKey(entry: DerivedWorkLogEntry): string | null {
  if (
    entry.activityKind !== "tool.started" &&
    entry.activityKind !== "tool.updated" &&
    entry.activityKind !== "tool.completed"
  ) {
    return null;
  }
  if (entry.itemId) {
    return `dedup-itemId\x1f${entry.itemId}`;
  }
  const fingerprint = entry.toolInput ? stableInputFingerprint(entry.toolInput) : null;
  if (!fingerprint) return null;
  const toolName = entry.toolName ?? "";
  const itemType = entry.itemType ?? "";
  return `${itemType}\x1f${toolName}\x1f${fingerprint}`;
}

function deduplicateToolLifecycleEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const bestByKey = new Map<string, DerivedWorkLogEntry>();
  const firstIndexByKey = new Map<string, number>();
  const duplicateIndices = new Set<number>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const key = toolDeduplicationKey(entry);
    if (!key) continue;

    const existing = bestByKey.get(key);
    if (existing) {
      bestByKey.set(key, mergeDerivedWorkLogEntries(existing, entry));
      duplicateIndices.add(i);
    } else {
      bestByKey.set(key, entry);
      firstIndexByKey.set(key, i);
    }
  }

  const result: DerivedWorkLogEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (duplicateIndices.has(i)) continue;
    const entry = entries[i]!;
    const key = toolDeduplicationKey(entry);
    result.push(key && bestByKey.has(key) ? bestByKey.get(key)! : entry);
  }
  return result;
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (
    previous.activityKind !== "tool.started" &&
    previous.activityKind !== "tool.updated" &&
    previous.activityKind !== "tool.completed"
  ) {
    return false;
  }
  if (
    next.activityKind !== "tool.started" &&
    next.activityKind !== "tool.updated" &&
    next.activityKind !== "tool.completed"
  ) {
    return false;
  }
  if (previous.activityKind === "tool.completed") {
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

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const changedFiles = mergeChangedFiles(previous.changedFiles, next.changedFiles);
  const detail = next.detail ?? previous.detail;
  const command = next.command ?? previous.command;
  const rawCommand = next.rawCommand ?? previous.rawCommand;
  const exitCode = next.exitCode ?? previous.exitCode;
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const toolName = next.toolName ?? previous.toolName;
  const toolInput = previous.toolInput ?? next.toolInput;
  const itemType = next.itemType ?? previous.itemType;
  const requestKind = next.requestKind ?? previous.requestKind;
  const itemId = next.itemId ?? previous.itemId;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const mergedDiffPreviews = mergeDiffPreviews(
    previous.diffPreviews ?? [],
    next.diffPreviews ?? [],
  );
  const toolCallId = next.toolCallId ?? previous.toolCallId;
  return {
    ...previous,
    ...next,
    createdAt: previous.createdAt,
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(rawCommand ? { rawCommand } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolInput ? { toolInput } : {}),
    ...(previous.toolCompleted || next.toolCompleted ? { toolCompleted: true } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(itemId ? { itemId } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(mergedDiffPreviews.length > 0 ? { diffPreviews: mergedDiffPreviews } : {}),
    ...(toolCallId ? { toolCallId } : {}),
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
  if (
    entry.activityKind !== "tool.started" &&
    entry.activityKind !== "tool.updated" &&
    entry.activityKind !== "tool.completed"
  ) {
    return undefined;
  }
  if (entry.itemId) {
    return `itemId\x1f${entry.itemId}`;
  }
  if (entry.toolCallId) {
    return `tool:${entry.toolCallId}`;
  }
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const itemType = entry.itemType ?? "";
  const inputFingerprint = entry.toolInput ? stableInputFingerprint(entry.toolInput) : null;
  const stableIdentifier = inputFingerprint ?? entry.detail?.trim() ?? "";
  if (normalizedLabel.length === 0 && stableIdentifier.length === 0 && itemType.length === 0) {
    return undefined;
  }
  return [itemType, normalizedLabel, stableIdentifier].join("\u001f");
}

function stableInputFingerprint(input: Record<string, unknown>): string | null {
  try {
    const serialized = JSON.stringify(input);
    return serialized.length > 0 && serialized !== "{}" ? serialized : null;
  } catch {
    return null;
  }
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
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const dataInput = asRecord(data?.input);
  const itemType = asTrimmedString(payload?.itemType);
  const detail = asTrimmedString(payload?.detail);
  const detailCommand =
    itemType === "command_execution" && detail
      ? (() => {
          const cleaned = stripTrailingExitCode(detail).output;
          if (!cleaned) return null;
          const split = splitExecutableAndRest(cleaned);
          if (!split) return null;
          const basename = executableBasename(split.executable);
          if (!basename) return null;
          const spec = findShellWrapperSpec(basename);
          return spec ? cleaned : null;
        })()
      : null;
  const candidates: unknown[] = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
    dataInput?.command,
    detailCommand,
  ];

  for (const candidate of candidates) {
    const command = normalizeCommandValue(candidate);
    if (!command) {
      continue;
    }
    return {
      command,
      rawCommand: toRawToolCommand(candidate, command),
    };
  }

  return {
    command: null,
    rawCommand: null,
  };
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

function extractToolName(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  return asTrimmedString(data?.toolName);
}

function extractToolInput(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  const data = asRecord(payload?.data);
  return asRecord(data?.input);
}

function extractToolCallId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  return asTrimmedString(data?.toolCallId);
}

function extractToolResultText(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const result = asRecord(data?.result);
  if (!result) return null;
  if (typeof result.content === "string" && result.content.length > 0) {
    return result.content;
  }
  if (Array.isArray(result.content)) {
    const texts = result.content
      .map((block: unknown) => {
        if (!block || typeof block !== "object") return "";
        const b = block as { type?: unknown; text?: unknown };
        return b.type === "text" && typeof b.text === "string" ? b.text : "";
      })
      .filter((text: string) => text.length > 0);
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
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

const EXIT_CODE_RE =
  /^(?<output>[\s\S]*?)(?:\s*<?(?:exited with (?:exit )?code|Exited with code) (?<code>\d+)>?)\s*$/i;

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
  const match = EXIT_CODE_RE.exec(trimmed);
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

function activityHasItemType(
  activity: OrchestrationThreadActivity,
  expected: ToolLifecycleItemType,
): boolean {
  const payload = activity.payload as Record<string, unknown> | null | undefined;
  return typeof payload?.itemType === "string" && payload.itemType === expected;
}

function activityHasItemId(activity: OrchestrationThreadActivity): boolean {
  const payload = activity.payload as Record<string, unknown> | null | undefined;
  return typeof payload?.itemId === "string" && payload.itemId.length > 0;
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

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  collectChangedFiles(asRecord(payload?.data), changedFiles, seen, 0);
  return changedFiles;
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
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
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
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
  const workRows: TimelineEntry[] = workEntries.map((entry) => ({
    id: entry.id,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));
  return [...messageRows, ...proposedPlanRows, ...workRows].toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
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

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}
