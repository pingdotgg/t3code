import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  ProviderDriverKind,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";

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
    value: ProviderDriverKind.make("grok"),
    label: "Grok",
    available: true,
    pickerSidebarBadge: "new",
  },
];

export type WorkLogToolLifecycleStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "declined"
  | "stopped";

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  turnId?: TurnId | null;
  label: string;
  detail?: string;
  command?: string;
  rawCommand?: string;
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  patch?: string;
  changedFiles?: ReadonlyArray<string>;
  subagentPrompt?: string;
  subagentChildren?: ReadonlyArray<SubagentWorkLogChild>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  toolData?: unknown;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  /** From runtime item / task payload `status` when present (e.g. tool.updated). */
  toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  /** Originating orchestration activity kind (e.g. `user-input.requested`) for row chrome. */
  sourceActivityKind?: OrchestrationThreadActivity["kind"];
}

export interface SubagentWorkLogChild {
  threadId: ThreadId;
  parentItemId?: string;
  titleSeed?: string;
}

const MAX_PATCH_SEARCH_DEPTH = 4;
const MAX_PATCH_STRINGS = 4;
const MAX_INLINE_PATCH_CHARS = 200_000;
const PATCH_TOO_LARGE_MESSAGE = `[patch omitted: exceeds ${MAX_INLINE_PATCH_CHARS} characters]`;

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

export function workLogEntryIsToolLike(entry: WorkLogEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") {
    return true;
  }
  if (entry.command !== undefined && entry.command.trim().length > 0) {
    return true;
  }
  if (entry.requestKind !== undefined) {
    return true;
  }
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

/** Heuristic: providers often emit successful lifecycle status while error text lives in `detail` / `command`. */
function toolDetailTextLooksLikeFailure(text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes("file not found")) {
    return true;
  }
  if (t.includes("no files found")) {
    return true;
  }
  if (
    t.includes("enoent") ||
    t.includes("no such file or directory") ||
    t.includes("no such file")
  ) {
    return true;
  }
  if (t.includes("cannot find path") && t.includes("because it does not exist")) {
    return true;
  }
  if (t.includes("commandnotfoundexception")) {
    return true;
  }
  if (t.includes("is not recognized as the name of a cmdlet")) {
    return true;
  }
  if (t.includes("is not recognized") && t.includes("the term '")) {
    return true;
  }
  if (t.includes("a parameter cannot be found that matches parameter name")) {
    return true;
  }
  if (t.includes("command not found")) {
    return true;
  }
  if (/<exited with exit code\s+[1-9]\d*\s*>/i.test(text)) {
    return true;
  }
  if (/exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text)) {
    return true;
  }
  if (/exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)) {
    return true;
  }
  return false;
}

/** True when the row should show a failure affordance (explicit status/tone or error-shaped tool output). */
export function workEntryIndicatesToolFailure(entry: WorkLogEntry): boolean {
  if (entry.tone === "error") {
    return true;
  }
  const ls = entry.toolLifecycleStatus;
  if (ls === "failed" || ls === "declined") {
    return true;
  }
  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }
  const parts: string[] = [];
  if (entry.detail) {
    parts.push(entry.detail);
  }
  if (entry.command) {
    parts.push(entry.command);
  }
  const blob = parts.join("\n");
  if (blob.length === 0) {
    return false;
  }
  return toolDetailTextLooksLikeFailure(blob);
}

/** Tool/command row completed without failure (blue check affordance). */
export function workEntryIndicatesToolSuccess(entry: WorkLogEntry): boolean {
  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }
  if (workEntryIndicatesToolFailure(entry)) {
    return false;
  }
  if (entry.tone === "thinking") {
    return false;
  }
  const ls = entry.toolLifecycleStatus;
  if (ls === "failed" || ls === "declined") {
    return false;
  }
  if (ls === "inProgress") {
    return false;
  }
  if (ls === "stopped") {
    return false;
  }
  return true;
}

/** Tool-like row with neither clear success nor failure (empty, incomplete, in progress, etc.). */
export function workEntryIndicatesToolNeutralStatus(entry: WorkLogEntry): boolean {
  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }
  if (entry.itemType === "collab_agent_tool_call" && (entry.subagentChildren?.length ?? 0) > 0) {
    return false;
  }
  if (workEntryIndicatesToolFailure(entry)) {
    return false;
  }
  if (workEntryIndicatesToolSuccess(entry)) {
    return false;
  }
  return true;
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;
    // 9.95s+ rounds up to the next bucket — render "10s", not "10.0s".
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
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
type SessionActivityState = Pick<NonNullable<Thread["session"]>, "status" | "activeTurnId">;

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  if (session.status === "running") return false;
  return true;
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  const runningTurnId = session?.status === "running" ? session.activeTurnId : null;
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
    normalized.includes("unknown pending user-input request") ||
    normalized.includes("unknown pending user input request") ||
    normalized.includes("unknown pending codex user input request")
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
  const steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }> = [];
  for (const entry of rawPlan) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.step !== "string") {
      continue;
    }
    const status =
      record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
    steps.push({
      step: record.step,
      status,
    });
  }
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
): WorkLogEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const entries: DerivedWorkLogEntry[] = [];
  for (const activity of ordered) {
    if (activity.kind === "tool.started") continue;
    if (activity.kind === "task.started") continue;
    if (activity.kind === "context-window.updated") continue;
    if (activity.summary === "Checkpoint captured") continue;
    if (isPlanBoundaryToolActivity(activity)) continue;
    entries.push(toDerivedWorkLogEntry(activity));
  }
  return dedupeSubagentChildWorkEntries(
    collapseDerivedWorkLogEntries(entries.filter((entry) => !isEmptySubagentWorkLogEntry(entry))),
  ).map((entry) => {
    const { activityKind, collapseKey: _collapseKey, ...rest } = entry;
    return Object.assign(rest, { sourceActivityKind: activityKind });
  });
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

function extractWorkLogToolLifecycleStatus(
  payload: Record<string, unknown> | null,
): WorkLogToolLifecycleStatus | undefined {
  if (!payload) {
    return undefined;
  }
  const s = payload.status;
  if (
    s === "inProgress" ||
    s === "completed" ||
    s === "failed" ||
    s === "declined" ||
    s === "stopped"
  ) {
    return s;
  }
  return undefined;
}

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const commandPreview = extractToolCommand(payload);
  const commandResult = extractCommandResult(payload, {
    preserveBlankRawOutputStreams: activity.kind === "tool.updated",
  });
  const changedFiles = extractChangedFiles(payload);
  const patch = extractToolPatch(payload);
  const title = extractToolTitle(payload);
  const isTaskActivity = activity.kind === "task.progress" || activity.kind === "task.completed";
  const taskSummary =
    isTaskActivity && typeof payload?.summary === "string" && payload.summary.length > 0
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
  const detail = isTaskActivity
    ? !taskDetailAsLabel &&
      payload &&
      typeof payload.detail === "string" &&
      payload.detail.length > 0
      ? stripTrailingExitCode(payload.detail).output
      : null
    : extractToolDetail(payload, title ?? activity.summary);
  const toolCallId = isTaskActivity ? null : extractToolCallId(payload);
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    label: taskLabel || activity.summary,
    tone:
      activity.kind === "task.progress"
        ? "thinking"
        : activity.tone === "approval"
          ? "info"
          : activity.tone,
    activityKind: activity.kind,
  };
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  const subagentOutput =
    itemType === "collab_agent_tool_call" ? extractSubagentOutput(payload) : null;
  const subagentPrompt =
    itemType === "collab_agent_tool_call" ? extractSubagentPrompt(payload, detail) : null;
  const subagentChildren =
    itemType === "collab_agent_tool_call" ? extractSubagentChildren(payload) : [];
  if (detail) {
    entry.detail = detail;
  }
  if (commandPreview.command) {
    entry.command = commandPreview.command;
  }
  if (commandPreview.rawCommand) {
    entry.rawCommand = commandPreview.rawCommand;
  }
  if (subagentOutput) {
    entry.output = subagentOutput;
  }
  const isCommandEntry =
    itemType === "command_execution" ||
    requestKind === "command" ||
    Boolean(commandPreview.command || commandPreview.rawCommand);
  if (
    commandResult.output &&
    !commandResult.stdout &&
    !commandResult.stderr &&
    !entry.output &&
    isCommandEntry
  ) {
    entry.output = commandResult.output;
  }
  if (commandResult.stdout) {
    entry.stdout = commandResult.stdout;
  }
  if (commandResult.stderr) {
    entry.stderr = commandResult.stderr;
  }
  if (commandResult.exitCode !== null) {
    entry.exitCode = commandResult.exitCode;
  }
  if (commandResult.durationMs !== null) {
    entry.durationMs = commandResult.durationMs;
  }
  if (patch) {
    entry.patch = patch;
  }
  if (changedFiles.length > 0) {
    entry.changedFiles = changedFiles;
  }
  if (subagentPrompt) {
    entry.subagentPrompt = subagentPrompt;
  }
  if (subagentChildren.length > 0) {
    entry.subagentChildren = subagentChildren;
  }
  if (title) {
    entry.toolTitle = title;
  }
  if (itemType === "mcp_tool_call") {
    const data = asRecord(payload?.data);
    if (data?.item !== undefined) {
      entry.toolData = data.item;
    }
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  if (toolCallId) {
    entry.toolCallId = toolCallId;
  }
  let toolLifecycleStatus = extractWorkLogToolLifecycleStatus(payload);
  if (!toolLifecycleStatus && activity.kind === "tool.completed") {
    toolLifecycleStatus = "completed";
  }
  if (toolLifecycleStatus) {
    entry.toolLifecycleStatus = toolLifecycleStatus;
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

function dedupeSubagentChildWorkEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const lastIndexByChildActivityKey = new Map<string, number>();
  const childByActivityKey = new Map<string, SubagentWorkLogChild>();

  for (const [index, entry] of entries.entries()) {
    if (entry.itemType !== "collab_agent_tool_call" || !entry.subagentChildren?.length) {
      continue;
    }
    for (const child of entry.subagentChildren) {
      const activityScope = child.parentItemId ?? entry.turnId ?? "";
      const key = `${child.threadId}:${activityScope}`;
      const existing = childByActivityKey.get(key);
      childByActivityKey.set(key, {
        threadId: child.threadId,
        ...(child.parentItemId ? { parentItemId: child.parentItemId } : {}),
        ...((existing?.titleSeed ?? child.titleSeed)
          ? { titleSeed: existing?.titleSeed ?? child.titleSeed }
          : {}),
      });
      lastIndexByChildActivityKey.set(key, index);
    }
  }

  return entries.flatMap((entry, index) => {
    if (entry.itemType !== "collab_agent_tool_call" || !entry.subagentChildren?.length) {
      return [entry];
    }
    const retainedChildren: SubagentWorkLogChild[] = [];
    const retainedKeys = new Set<string>();
    for (const child of entry.subagentChildren) {
      const activityScope = child.parentItemId ?? entry.turnId ?? "";
      const key = `${child.threadId}:${activityScope}`;
      if (retainedKeys.has(key) || lastIndexByChildActivityKey.get(key) !== index) {
        continue;
      }
      retainedKeys.add(key);
      retainedChildren.push(childByActivityKey.get(key) ?? child);
    }
    if (retainedChildren.length === 0) {
      return [];
    }
    return [
      {
        ...entry,
        subagentChildren: retainedChildren,
      },
    ];
  });
}

function isEmptySubagentWorkLogEntry(entry: DerivedWorkLogEntry): boolean {
  return (
    entry.itemType === "collab_agent_tool_call" &&
    !entry.detail &&
    !entry.subagentPrompt &&
    !entry.output &&
    (entry.subagentChildren?.length ?? 0) === 0
  );
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
  if (
    previous.activityKind === "tool.completed" &&
    !(
      next.activityKind === "tool.updated" &&
      previous.toolCallId !== undefined &&
      previous.toolCallId === next.toolCallId
    )
  ) {
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
  const itemType = next.itemType ?? previous.itemType;
  const detail =
    itemType === "collab_agent_tool_call"
      ? (previous.detail ?? next.detail)
      : (next.detail ?? previous.detail);
  const command = next.command ?? previous.command;
  const rawCommand = next.rawCommand ?? previous.rawCommand;
  const output =
    itemType === "collab_agent_tool_call"
      ? mergeTextOutputChunk(previous.output, next.output)
      : mergeTextOutput(previous.output, next.output, next);
  const stdout = mergeTextOutput(previous.stdout, next.stdout, next);
  const stderr = mergeTextOutput(previous.stderr, next.stderr, next);
  const exitCode = next.exitCode ?? previous.exitCode;
  const durationMs = next.durationMs ?? previous.durationMs;
  const patch = next.patch ?? previous.patch;
  const subagentPrompt =
    itemType === "collab_agent_tool_call"
      ? (previous.subagentPrompt ?? next.subagentPrompt)
      : (next.subagentPrompt ?? previous.subagentPrompt);
  const subagentChildren =
    itemType === "collab_agent_tool_call"
      ? mergeSubagentChildren(previous.subagentChildren, next.subagentChildren)
      : (next.subagentChildren ?? previous.subagentChildren);
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const requestKind = next.requestKind ?? previous.requestKind;
  const toolCallId = next.toolCallId ?? previous.toolCallId;
  const collapseKey = toolCallId
    ? `tool:${toolCallId}`
    : (next.collapseKey ?? previous.collapseKey);
  const toolLifecycleStatus = next.toolLifecycleStatus ?? previous.toolLifecycleStatus;
  const toolData = next.toolData ?? previous.toolData;
  return {
    ...previous,
    ...next,
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(rawCommand ? { rawCommand } : {}),
    ...(output ? { output } : {}),
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(patch ? { patch } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(subagentPrompt ? { subagentPrompt } : {}),
    ...(subagentChildren && subagentChildren.length > 0 ? { subagentChildren } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolLifecycleStatus !== undefined ? { toolLifecycleStatus } : {}),
    ...(toolData !== undefined ? { toolData } : {}),
  };
}

function mergeSubagentChildren(
  previous: ReadonlyArray<SubagentWorkLogChild> | undefined,
  next: ReadonlyArray<SubagentWorkLogChild> | undefined,
): ReadonlyArray<SubagentWorkLogChild> | undefined {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return undefined;
  }
  const byChildActivity = new Map<string, SubagentWorkLogChild>();
  for (const child of merged) {
    const key = `${child.threadId}:${child.parentItemId ?? ""}`;
    const existing = byChildActivity.get(key);
    const titleSeed = existing?.titleSeed ?? child.titleSeed;
    byChildActivity.set(key, {
      threadId: child.threadId,
      ...(child.parentItemId ? { parentItemId: child.parentItemId } : {}),
      ...(titleSeed ? { titleSeed } : {}),
    });
  }
  return [...byChildActivity.values()];
}

function mergeTextOutput(
  previous: string | undefined,
  next: string | undefined,
  nextEntry: DerivedWorkLogEntry,
): string | undefined {
  if (!previous) {
    return next;
  }
  if (!next) {
    return previous;
  }
  if (previous === next) {
    return next;
  }
  if (next.startsWith(previous)) {
    return next;
  }
  if (previous.startsWith(next) && shouldKeepLongerOutputSnapshot(previous, next, nextEntry)) {
    return previous;
  }
  return `${previous}${next}`;
}

function mergeTextOutputChunk(
  previous: string | undefined,
  next: string | undefined,
): string | undefined {
  if (!previous) {
    return next;
  }
  if (!next) {
    return previous;
  }
  return `${previous}${next}`;
}

function shouldKeepLongerOutputSnapshot(
  previous: string,
  next: string,
  nextEntry: DerivedWorkLogEntry,
): boolean {
  return (
    nextEntry.activityKind === "tool.completed" ||
    next.endsWith("\n") ||
    isLikelyShorterOutputSnapshot(previous, next)
  );
}

function isLikelyShorterOutputSnapshot(previous: string, next: string): boolean {
  if (next.length <= 1) {
    return false;
  }
  // Multiline prefix matches are ambiguous; favor preserving incremental chunks over dropping output.
  if (previous.includes("\n")) {
    return false;
  }
  const following = previous[next.length];
  return following === " " || following === "\t" || following === "\n" || following === "\r";
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
  if (entry.toolCallId) {
    return `tool:${entry.toolCallId}`;
  }
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const detail = entry.detail?.trim() ?? "";
  const itemType = entry.itemType ?? "";
  if (normalizedLabel.length === 0 && detail.length === 0 && itemType.length === 0) {
    return undefined;
  }
  return [itemType, normalizedLabel, detail].join("\u001f");
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
  const parts: Array<string> = [];
  for (const entry of value) {
    const part = asTrimmedString(entry);
    if (part !== null) {
      parts.push(part);
    }
  }
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
  const itemType = asTrimmedString(payload?.itemType);
  const detail = asTrimmedString(payload?.detail);
  const candidates: unknown[] = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
    itemType === "command_execution" && detail ? stripTrailingExitCode(detail).output : null,
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

function firstNumberFromRecord(
  record: Record<string, unknown> | null,
  keys: ReadonlyArray<string>,
): number | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = asNumber(record[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function firstIntegerFromRecord(
  record: Record<string, unknown> | null,
  keys: ReadonlyArray<string>,
): number | null {
  const value = firstNumberFromRecord(record, keys);
  return value !== null && Number.isInteger(value) ? value : null;
}

function extractCommandResult(
  payload: Record<string, unknown> | null,
  options: {
    readonly preserveBlankRawOutputStreams?: boolean;
  } = {},
): {
  output: string | null;
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  durationMs: number | null;
} {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const rawOutput = asRecord(data?.rawOutput);
  const rawOutputStdout = options.preserveBlankRawOutputStreams
    ? firstRawStringFromRecord(rawOutput, ["stdout"])
    : firstCommandOutputStringFromRecord(rawOutput, ["stdout"]);
  const stdout =
    rawOutputStdout ??
    firstCommandOutputStringFromRecord(itemResult, ["stdout"]) ??
    firstCommandOutputStringFromRecord(data, ["stdout"]) ??
    firstCommandOutputStringFromRecord(payload, ["stdout"]);
  const stderr =
    (options.preserveBlankRawOutputStreams
      ? firstRawStringFromRecord(rawOutput, ["stderr"])
      : firstCommandOutputStringFromRecord(rawOutput, ["stderr"])) ??
    firstCommandOutputStringFromRecord(itemResult, ["stderr"]) ??
    firstCommandOutputStringFromRecord(data, ["stderr"]) ??
    firstCommandOutputStringFromRecord(payload, ["stderr"]);
  const rawOutputContent = options.preserveBlankRawOutputStreams
    ? firstRawStringFromRecord(rawOutput, ["content", "output", "text", "result"])
    : firstCommandOutputStringFromRecord(rawOutput, ["content", "output", "text", "result"]);
  const content =
    stdout ??
    rawOutputContent ??
    firstCommandOutputStringFromRecord(itemResult, ["content", "output", "text", "result"]) ??
    firstCommandOutputStringFromRecord(item, ["aggregatedOutput", "output", "text", "result"]);
  const strippedContent = content ? stripTrailingExitCode(content) : null;
  const detailExit =
    typeof payload?.detail === "string" ? stripTrailingExitCode(payload.detail) : null;
  const exitCode =
    firstIntegerFromRecord(rawOutput, ["exitCode", "code"]) ??
    firstIntegerFromRecord(itemResult, ["exitCode", "code"]) ??
    firstIntegerFromRecord(item, ["exitCode", "code"]) ??
    firstIntegerFromRecord(data, ["exitCode", "code"]) ??
    firstIntegerFromRecord(payload, ["exitCode", "code"]) ??
    strippedContent?.exitCode ??
    detailExit?.exitCode ??
    null;
  const elapsedSeconds =
    firstNumberFromRecord(rawOutput, ["elapsedSeconds"]) ??
    firstNumberFromRecord(itemResult, ["elapsedSeconds"]) ??
    firstNumberFromRecord(item, ["elapsedSeconds"]) ??
    firstNumberFromRecord(data, ["elapsedSeconds"]) ??
    firstNumberFromRecord(payload, ["elapsedSeconds"]);
  const durationMs =
    firstNumberFromRecord(rawOutput, ["durationMs", "elapsedMs"]) ??
    firstNumberFromRecord(itemResult, ["durationMs", "elapsedMs"]) ??
    firstNumberFromRecord(item, ["durationMs", "elapsedMs"]) ??
    firstNumberFromRecord(data, ["durationMs", "elapsedMs"]) ??
    firstNumberFromRecord(payload, ["durationMs", "elapsedMs"]) ??
    (elapsedSeconds !== null ? elapsedSeconds * 1000 : null);
  const strippedStdout = stdout ? stripTrailingExitCode(stdout) : null;
  const normalizedOutput =
    strippedContent?.exitCode !== undefined ? strippedContent.output : (content ?? null);

  return {
    // `output` is the legacy fallback stream; callers should prefer stdout/stderr when present.
    output: normalizedOutput,
    stdout: strippedStdout?.exitCode !== undefined ? strippedStdout.output : stdout,
    stderr,
    exitCode,
    durationMs,
  };
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

function extractToolCallId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const parentCollab = asRecord(data?.parentCollab);
  return (
    asTrimmedString(data?.toolCallId) ??
    asTrimmedString(parentCollab?.itemId) ??
    asTrimmedString(data?.itemId) ??
    asTrimmedString(item?.id)
  );
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
  const lines: Array<string> = [];
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = normalizeInlinePreview(rawLine);
    if (line.length > 0) {
      lines.push(line);
    }
  }
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

function firstStringFromRecord(
  record: Record<string, unknown> | null,
  keys: ReadonlyArray<string>,
): string | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = asTrimmedString(record[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function firstRawStringFromRecord(
  record: Record<string, unknown> | null,
  keys: ReadonlyArray<string>,
): string | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function firstCommandOutputStringFromRecord(
  record: Record<string, unknown> | null,
  keys: ReadonlyArray<string>,
): string | null {
  const value = firstRawStringFromRecord(record, keys);
  return value !== null && /\S/u.test(value) ? value : null;
}

function looksLikeUnifiedDiff(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("diff --git ") ||
    trimmed.startsWith("--- ") ||
    trimmed.startsWith("@@ ") ||
    /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/u.test(trimmed)
  );
}

function codexChangeKindType(record: Record<string, unknown>): string | null {
  const kind = record.kind;
  if (typeof kind === "string") {
    return kind;
  }
  const kindRecord = asRecord(kind);
  return asTrimmedString(kindRecord?.type);
}

function patchPathFromRecord(record: Record<string, unknown>): string | null {
  return (
    asTrimmedString(record.path) ??
    asTrimmedString(record.filePath) ??
    asTrimmedString(record.relativePath) ??
    asTrimmedString(record.filename) ??
    asTrimmedString(record.newPath) ??
    asTrimmedString(record.oldPath)
  );
}

function normalizeDiffHeaderPath(path: string): string {
  return path.replace(/\\/gu, "/");
}

function toUnifiedPatchFromRecordDiff(
  record: Record<string, unknown>,
  diff: string,
): string | null {
  if (diff.startsWith("diff --git ") || diff.startsWith("--- ")) {
    return diff;
  }
  const trimmed = diff.trimEnd();
  if (trimmed.length === 0) {
    return null;
  }

  const rawPath = patchPathFromRecord(record);
  if (!rawPath) {
    return looksLikeUnifiedDiff(trimmed) ? trimmed : null;
  }
  const path = normalizeDiffHeaderPath(rawPath);

  if (codexChangeKindType(record) === "add") {
    if (trimmed.startsWith("@@ ")) {
      return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n${trimmed}`;
    }
    const lines = trimmed.length > 0 ? trimmed.split(/\r?\n/u) : [];
    const addedLines = lines.map((line) => `+${line}`).join("\n");
    return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${addedLines}`;
  }

  if (trimmed.startsWith("@@ ")) {
    return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${trimmed}`;
  }

  return null;
}

function collectPatchStrings(
  value: unknown,
  patches: string[],
  seen: Set<string>,
  depth: number,
  includeNested = true,
): void {
  if (depth > MAX_PATCH_SEARCH_DEPTH || patches.length >= MAX_PATCH_STRINGS) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPatchStrings(entry, patches, seen, depth + 1, includeNested);
      if (patches.length >= MAX_PATCH_STRINGS) {
        return;
      }
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  for (const key of ["patch", "diff", "unifiedDiff"]) {
    const rawCandidate = typeof record[key] === "string" ? record[key] : null;
    const candidate = rawCandidate ? toUnifiedPatchFromRecordDiff(record, rawCandidate) : null;
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    if (candidate.length > MAX_INLINE_PATCH_CHARS) {
      seen.add(candidate);
      patches.push(PATCH_TOO_LARGE_MESSAGE);
      continue;
    }
    if (!looksLikeUnifiedDiff(candidate)) {
      continue;
    }
    seen.add(candidate);
    patches.push(candidate);
  }
  if (!includeNested) {
    return;
  }
  for (const nestedKey of ["item", "result", "input", "data", "changes", "files", "edits"]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectPatchStrings(record[nestedKey], patches, seen, depth + 1, includeNested);
    if (patches.length >= MAX_PATCH_STRINGS) {
      return;
    }
  }
}

function extractToolPatch(payload: Record<string, unknown> | null): string | null {
  const patches: string[] = [];
  const seen = new Set<string>();
  if (payload) {
    collectPatchStrings(payload, patches, seen, 0, false);
  }
  const data = asRecord(payload?.data);
  // Keep traversal bounded; provider payloads can nest raw tool data deeply.
  collectPatchStrings(data, patches, seen, 0);
  return patches.length > 0 ? patches.join("\n\n") : null;
}

function extractSubagentOutput(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const rawOutput = asRecord(data?.rawOutput);
  return firstRawStringFromRecord(rawOutput, ["content", "output", "text", "stdout", "result"]);
}

function extractSubagentPrompt(
  payload: Record<string, unknown> | null,
  fallbackDetail: string | null,
): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const rawInput = asRecord(data?.rawInput);
  const parentCollab = asRecord(data?.parentCollab);
  return (
    asTrimmedString(parentCollab?.detail) ??
    firstStringFromRecord(itemInput, ["prompt", "message", "description", "task"]) ??
    firstStringFromRecord(rawInput, ["prompt", "message", "description", "task"]) ??
    firstStringFromRecord(item, ["prompt", "message", "description", "task"]) ??
    fallbackDetail
  );
}

function extractSubagentChildren(
  payload: Record<string, unknown> | null,
): ReadonlyArray<SubagentWorkLogChild> {
  const data = asRecord(payload?.data);
  const children = Array.isArray(data?.subagentChildren) ? data.subagentChildren : [];
  const result: SubagentWorkLogChild[] = [];
  const seen = new Set<string>();
  for (const value of children) {
    const record = asRecord(value);
    const rawThreadId = asTrimmedString(record?.childThreadId) ?? asTrimmedString(record?.threadId);
    if (!rawThreadId) {
      continue;
    }
    const titleSeed = asTrimmedString(record?.titleSeed);
    const parentItemId = asTrimmedString(record?.parentItemId);
    const key = `${rawThreadId}:${parentItemId ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      threadId: ThreadId.make(rawThreadId),
      ...(parentItemId ? { parentItemId } : {}),
      ...(titleSeed ? { titleSeed } : {}),
    });
  }
  return result;
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

  // Stable sort preserves arrival order for unsequenced same-timestamp events.
  // Streaming text chunks can share millisecond timestamps; sorting those by
  // random event ids can scramble the reconstructed output.
  return 0;
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

export function deriveTimelineEntries(
  messages: ReadonlyArray<ChatMessage>,
  proposedPlans: ReadonlyArray<ProposedPlan>,
  workEntries: ReadonlyArray<WorkLogEntry>,
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
  summaries: ReadonlyArray<TurnDiffSummary>,
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

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (
    !session ||
    session.status === "stopped" ||
    session.status === "interrupted" ||
    session.status === "error"
  ) {
    return "disconnected";
  }
  if (session.status === "starting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}
