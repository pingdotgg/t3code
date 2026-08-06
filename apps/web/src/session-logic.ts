import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import { isBackgroundTaskActivity } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  ProviderDriverKind,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  type ThreadId,
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
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  toolData?: unknown;
  /** Raw provider tool name (e.g. `Bash`, `Read`) when the adapter carries it in `payload.data`. */
  toolName?: string;
  /** Raw provider tool input when the adapter carries it in `payload.data`. */
  toolInput?: Record<string, unknown>;
  /** Line-level diff for file-edit tools, from the provider result or reconstructed from input. */
  toolDiff?: WorkLogToolDiff;
  /** Text content of the tool result block when the adapter carries it in `payload.data`. */
  toolResultText?: string;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  /** From runtime item / task payload `status` when present (e.g. tool.updated). */
  toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  /** Originating orchestration activity kind (e.g. `user-input.requested`) for row chrome. */
  sourceActivityKind?: OrchestrationThreadActivity["kind"];
  /** Grouping key for subagent lifecycle rows (one row per agent). */
  taskId?: string;
  /** Agent role (subagent_type) for labeled timeline rows. */
  agentRole?: string;
  /**
   * Present on agent-spawn CTA rows: one per workflow run or per-turn batch
   * of direct spawns. The row renders as a call-to-action ("Kicked off N
   * subagents") whose live status is derived from the agent panel model at
   * render time; clicking opens the Agents panel.
   */
  agentSpawn?: {
    /** Workflow coordinator taskId, or null for a direct-spawn batch. */
    workflowId: string | null;
    agentTaskIds: ReadonlyArray<string>;
  };
}

export interface WorkLogToolDiffHunk {
  /** 1-based line numbers in the old/new file; null when reconstructed from streaming input. */
  oldStart: number | null;
  newStart: number | null;
  /** Unified-diff lines including their leading `+` / `-` / ` ` marker. */
  lines: ReadonlyArray<string>;
}

export interface WorkLogToolDiff {
  filePath: string | null;
  hunks: ReadonlyArray<WorkLogToolDiffHunk>;
  truncated: boolean;
}

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
  toolCallId?: string;
  isWorkflowCoordinator?: boolean;
  /** Shell/monitor/plan tasks: ordinary work-log rows, never spawn CTAs. */
  isBackgroundTask?: boolean;
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
  // Spawn CTA rows are never neutral-hidden: mid-run they derive from
  // task.progress (tone "thinking") and the neutral filter was swallowing
  // them exactly while the fleet ran — the one moment they matter most.
  if (entry.agentSpawn !== undefined) {
    return false;
  }
  // Completed thinking bursts are informational rows, not stuck tools — they
  // must survive the neutral-status filter that hides incomplete tool rows.
  if (entry.sourceActivityKind === "thinking.completed") {
    return false;
  }
  if (!workLogEntryIsToolLike(entry)) {
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

/**
 * Quiet-timeline guarantee: the work log carries the parent's narrative plus
 * at most one row per agent. Everything an agent does internally lives in the
 * Agents surface:
 * - timelineBypass rows (Codex children, workflow members) never render here;
 * - tool rows attributed to an owning agent (payload.agentId) are re-homed;
 * - task.progress ticks collapse into one row per taskId;
 * - task.updated is fold input only (status patches are not narrative).
 * Unattributed rows always stay: over-hiding loses the only terminal signal.
 */
/** Agent (non-background) task.started rows seed spawn CTA batches. */
function isAgentTaskStartedActivity(activity: OrchestrationThreadActivity): boolean {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (!payload || typeof payload.taskId !== "string") {
    return false;
  }
  return !isBackgroundTaskActivity(payload);
}

function isAgentInternalActivity(activity: OrchestrationThreadActivity): boolean {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (!payload) {
    return false;
  }
  const isTaskRow =
    activity.kind === "task.started" ||
    activity.kind === "task.progress" ||
    activity.kind === "task.updated" ||
    activity.kind === "task.completed";
  // Task rows classify by the server stamp: a subagent's own background
  // shell (agentId + "background") is agent-internal, but a nested AGENT
  // (agentId + "agent") stays visible so its rows can anchor a spawn CTA
  // (review finding: hiding on agentId alone removed nested agents and
  // their anchors). Bypassed agent lifecycle rows also pass — collapse
  // folds every such row into its batch's single CTA row, which is how
  // Codex children (whose rows are ALL bypassed) get an anchor at the
  // spawn point.
  if (isTaskRow) {
    const ownedByAgent = typeof payload.agentId === "string" && payload.agentId.trim().length > 0;
    if (ownedByAgent || payload.timelineBypass === true) {
      const isAgentTaskRow =
        activity.kind !== "task.updated" &&
        typeof payload.taskId === "string" &&
        !isBackgroundTaskActivity(payload);
      return !isAgentTaskRow;
    }
    return false;
  }
  if (payload.timelineBypass === true) {
    return true;
  }
  // Non-task rows (attributed tool activity) owned by an agent are internal.
  return typeof payload.agentId === "string" && payload.agentId.trim().length > 0;
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): WorkLogEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const entries: DerivedWorkLogEntry[] = [];
  for (const activity of ordered) {
    if (activity.kind === "tool.started") continue;
    // Agent task.started rows are CTA seeds: they carry the true spawn turn,
    // which is the batch key (completions of background subagents arrive
    // under later synthetic turns and must not start new batches). They
    // collapse into the batch's single CTA row, never render standalone.
    if (activity.kind === "task.started" && !isAgentTaskStartedActivity(activity)) continue;
    if (activity.kind === "task.updated") continue;
    if (activity.kind === "tool.progress") continue;
    if (activity.kind === "context-window.updated") continue;
    // In-flight thinking feeds the live working indicator; only the completed
    // burst earns a durable "Thought for Xs" row.
    if (activity.kind === "thinking.started") continue;
    if (activity.kind === "thinking.progress") continue;
    if (activity.summary === "Checkpoint captured") continue;
    if (isPlanBoundaryToolActivity(activity)) continue;
    if (isAgentInternalActivity(activity)) continue;
    entries.push(toDerivedWorkLogEntry(activity));
  }
  const collapsed = collapseDerivedWorkLogEntries(entries);
  // A "compacting" marker is only meaningful until its compaction boundary
  // arrives; after that the completed row alone marks the spot.
  const lastCompactionBoundary = collapsed.findLastIndex(
    (entry) => entry.activityKind === "context-compaction",
  );
  return collapsed
    .filter(
      (entry, index) =>
        !(entry.activityKind === "context-compaction.started" && index < lastCompactionBoundary),
    )
    .map((entry) => {
      const { activityKind, collapseKey: _collapseKey, ...rest } = entry;
      return Object.assign(rest, { sourceActivityKind: activityKind });
    });
}

export interface LiveWorkStatus {
  kind: "thinking" | "tool" | "responding";
  /** e.g. "Thinking", "Running pnpm test", "Writing" */
  label: string;
  /** Start of the current phase, for a live elapsed timer. */
  since: string | null;
  /** Streamed reasoning size so far (characters), when the provider reports it. */
  thinkingChars?: number;
  /** Full accumulated streamed reasoning text for the open thinking burst. */
  thinkingText?: string;
}

function truncateLiveStatusLabel(value: string, maxLength = 56): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function liveToolStatusLabel(entry: DerivedWorkLogEntry): string {
  if (entry.command) {
    // A tool.started can land before its input streamed in ("Bash: {}").
    const command = entry.command.replace(/:?\s*\{\}\s*$/, "");
    if (command.length > 0) {
      return `Running ${truncateLiveStatusLabel(command)}`;
    }
  }
  if (entry.itemType === "web_search") {
    return "Searching the web";
  }
  const changedFile = entry.toolDiff?.filePath ?? entry.changedFiles?.[0];
  if (entry.itemType === "file_change" || changedFile) {
    if (changedFile) {
      const basename = changedFile.replace(/\\/g, "/").split("/").at(-1);
      if (basename) {
        return `Editing ${truncateLiveStatusLabel(basename)}`;
      }
    }
    return "Editing files";
  }
  const heading = normalizeCompactToolLabel(entry.toolTitle ?? entry.label)
    .replace(/\s+started\s*$/i, "")
    .trim();
  return heading.length > 0 ? truncateLiveStatusLabel(heading) : "Running a tool";
}

/**
 * What the provider is doing right now, derived from the newest live signal:
 * an open thinking burst, an in-flight tool call, or a streaming assistant
 * message. Returns null when there is no signal (callers fall back to a
 * generic "Working" indicator).
 */
export function deriveLiveWorkStatus(input: {
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  runningTurnId: TurnId | null;
  streamingMessage: { createdAt: string; updatedAt: string } | null;
  /**
   * Current Claude models never stream thinking text (blocks arrive encrypted
   * with only a signature), so no thinking-burst activities exist to report.
   * For those providers a silent stretch of a running turn — no tool open, no
   * text streaming — is the model thinking, so label it that way instead of
   * falling back to the generic "Working".
   */
  assumeThinkingWhenSilent?: boolean;
}): LiveWorkStatus | null {
  if (input.runningTurnId === null) {
    return null;
  }
  const ordered = [...input.activities].toSorted(compareActivitiesByOrder);
  let lastTurnSignalAt: string | null = null;

  interface OpenThinkingBurst {
    burstId: string;
    startedAt: string;
    chars: number;
    text: string | null;
    lastAt: string;
  }
  let openThinking: OpenThinkingBurst | null = null;
  const openToolsByKey = new Map<
    string,
    { entry: DerivedWorkLogEntry; since: string; lastAt: string }
  >();

  for (const activity of ordered) {
    if (activity.turnId !== null && activity.turnId !== input.runningTurnId) {
      continue;
    }
    if (
      activity.turnId === input.runningTurnId &&
      (lastTurnSignalAt === null || activity.createdAt.localeCompare(lastTurnSignalAt) > 0)
    ) {
      lastTurnSignalAt = activity.createdAt;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;

    if (activity.kind === "thinking.started") {
      openThinking = {
        burstId: typeof payload?.burstId === "string" ? payload.burstId : activity.id,
        startedAt: typeof payload?.startedAt === "string" ? payload.startedAt : activity.createdAt,
        chars: 0,
        text: null,
        lastAt: activity.createdAt,
      };
      continue;
    }
    if (activity.kind === "thinking.progress") {
      // Some providers keep one thinking burst open across interleaved tool
      // calls, so a progress event may arrive after a tool activity cleared
      // the open burst — re-open it from the progress payload.
      // Prefer full `text` (current servers); fall back to legacy `textTail`.
      const payloadText = typeof payload?.text === "string" ? payload.text : null;
      const payloadTextTail = typeof payload?.textTail === "string" ? payload.textTail : null;
      const nextText: string | null = payloadText ?? payloadTextTail ?? openThinking?.text ?? null;
      openThinking = {
        burstId:
          typeof payload?.burstId === "string"
            ? payload.burstId
            : (openThinking?.burstId ?? activity.id),
        startedAt:
          typeof payload?.startedAt === "string"
            ? payload.startedAt
            : (openThinking?.startedAt ?? activity.createdAt),
        chars: typeof payload?.chars === "number" ? payload.chars : (openThinking?.chars ?? 0),
        text: nextText,
        lastAt: activity.createdAt,
      };
      continue;
    }
    if (activity.kind === "thinking.completed") {
      openThinking = null;
      continue;
    }

    if (
      activity.kind === "tool.started" ||
      activity.kind === "tool.updated" ||
      activity.kind === "tool.completed"
    ) {
      // A tool call means the model moved past any open thinking burst even if
      // the burst-completion activity was lost.
      openThinking = null;
      const entry = toDerivedWorkLogEntry(activity);
      const key = entry.toolCallId ?? entry.collapseKey ?? entry.id;
      if (
        activity.kind === "tool.completed" ||
        (entry.toolLifecycleStatus !== undefined && entry.toolLifecycleStatus !== "inProgress")
      ) {
        openToolsByKey.delete(key);
        continue;
      }
      const existing = openToolsByKey.get(key);
      openToolsByKey.set(key, {
        entry: existing ? { ...existing.entry, ...entry } : entry,
        since: existing?.since ?? activity.createdAt,
        lastAt: activity.createdAt,
      });
    }
  }

  const latestOpenTool = [...openToolsByKey.values()].reduce<{
    entry: DerivedWorkLogEntry;
    since: string;
    lastAt: string;
  } | null>((latest, candidate) => {
    if (!latest || candidate.lastAt.localeCompare(latest.lastAt) > 0) {
      return candidate;
    }
    return latest;
  }, null);

  const candidates: Array<{ status: LiveWorkStatus; lastAt: string }> = [];
  if (openThinking) {
    candidates.push({
      status: {
        kind: "thinking",
        label: "Thinking",
        since: openThinking.startedAt,
        ...(openThinking.chars > 0 ? { thinkingChars: openThinking.chars } : {}),
        ...(openThinking.text !== null && openThinking.text.trim().length > 0
          ? { thinkingText: openThinking.text }
          : {}),
      },
      lastAt: openThinking.lastAt,
    });
  }
  if (latestOpenTool) {
    candidates.push({
      status: {
        kind: "tool",
        label: liveToolStatusLabel(latestOpenTool.entry),
        since: latestOpenTool.since,
      },
      lastAt: latestOpenTool.lastAt,
    });
  }
  if (input.streamingMessage) {
    candidates.push({
      status: {
        kind: "responding",
        label: "Writing",
        since: input.streamingMessage.createdAt,
      },
      lastAt: input.streamingMessage.updatedAt,
    });
  }

  const winner = candidates.reduce<{ status: LiveWorkStatus; lastAt: string } | null>(
    (latest, candidate) => {
      if (!latest || candidate.lastAt.localeCompare(latest.lastAt) > 0) {
        return candidate;
      }
      return latest;
    },
    null,
  );
  if (winner) {
    return winner.status;
  }
  if (input.assumeThinkingWhenSilent) {
    // Silence started at the newest signal the turn produced; with none yet
    // the row falls back to its own turn-start timestamp.
    return { kind: "thinking", label: "Thinking", since: lastTurnSignalAt };
  }
  return null;
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
  if (activity.kind === "thinking.completed") {
    const thinkingText = typeof payload?.text === "string" ? payload.text.trim() : "";
    return {
      id: activity.id,
      createdAt: activity.createdAt,
      turnId: activity.turnId,
      label: activity.summary,
      tone: "thinking",
      activityKind: activity.kind,
      ...(thinkingText.length > 0
        ? { detail: payload?.textTruncated === true ? `${thinkingText}…` : thinkingText }
        : {}),
    };
  }
  const commandPreview = extractToolCommand(payload);
  const changedFiles = extractChangedFiles(payload);
  const title = extractToolTitle(payload);
  const isTaskActivity =
    activity.kind === "task.started" ||
    activity.kind === "task.progress" ||
    activity.kind === "task.completed";
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
  if (itemType === "mcp_tool_call") {
    const data = asRecord(payload?.data);
    if (data?.item !== undefined) {
      entry.toolData = data.item;
    }
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (!isTaskActivity) {
    const normalizedItem = normalizeCodexToolItem(payload) ?? normalizeAcpToolCall(payload);
    const toolName = extractToolName(payload) ?? normalizedItem?.toolName ?? null;
    const toolInput = extractToolInput(payload) ?? normalizedItem?.toolInput ?? null;
    if (toolName) {
      entry.toolName = toolName;
    }
    if (toolInput) {
      entry.toolInput = toolInput;
    }
    const toolDiff =
      extractToolDiff(payload, toolName, toolInput) ?? normalizedItem?.toolDiff ?? null;
    if (toolDiff) {
      entry.toolDiff = toolDiff;
    }
    const toolResultText = extractToolResultText(payload) ?? normalizedItem?.toolResultText ?? null;
    if (toolResultText) {
      entry.toolResultText = toolResultText;
    }
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
  if (isTaskActivity && typeof payload?.taskId === "string" && payload.taskId.length > 0) {
    entry.taskId = payload.taskId;
  }
  if (isTaskActivity && typeof payload?.role === "string" && payload.role.length > 0) {
    entry.agentRole = payload.role;
  }
  if (
    isTaskActivity &&
    (payload?.taskType === "local_workflow" ||
      (typeof payload?.workflowName === "string" && payload.workflowName.length > 0))
  ) {
    entry.isWorkflowCoordinator = true;
  }
  if (isTaskActivity && payload && isBackgroundTaskActivity(payload)) {
    entry.isBackgroundTask = true;
  }
  const collapseKey = deriveToolLifecycleCollapseKey(entry);
  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }
  return entry;
}

/**
 * Spawn-group key for a subagent lifecycle row. Workflow members and their
 * coordinator share the coordinator's group; direct spawns batch per turn.
 * One CTA row per group (A1 design): "Kicked off N subagents".
 */
function agentSpawnGroupKey(entry: DerivedWorkLogEntry): string {
  const taskId = entry.taskId ?? "";
  const workflowSlot = taskId.indexOf(":wf:");
  if (workflowSlot !== -1) {
    return `wf:${taskId.slice(0, workflowSlot)}`;
  }
  if (entry.agentSpawn?.workflowId) {
    return `wf:${entry.agentSpawn.workflowId}`;
  }
  if (entry.isWorkflowCoordinator) {
    return `wf:${taskId}`;
  }
  // No turn id means no batch signal at all: fall back to one group per
  // task. Unrelated turn-less spawns (separate fleets whose rows lost their
  // turn) must not collapse into one immortal "direct:no-turn" CTA
  // accumulating every agent the thread ever ran (review finding). Adapters
  // stamp spawn turns (Codex spawnTurnId; Claude rows ride real turns), so
  // this path is defensive.
  return entry.turnId ? `direct:${entry.turnId}` : `direct:task:${taskId}`;
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  // Subagent rows collapse by spawn group, not adjacency: a workflow run (or
  // a turn's batch of direct spawns) is ONE narrative event in the chat — a
  // CTA row that opens the Agents panel — no matter how many agents it
  // contains or how their progress rows interleave (quiet-timeline
  // guarantee).
  const spawnRowIndex = new Map<string, number>();
  // Batch membership is decided once, at the FIRST row seen for a taskId.
  // Claude background subagents settle between turns, so their completion
  // rows carry fresh synthetic turn ids (or none) — keying each row by its
  // own turn splintered one batch into a stream of "Kicked off N subagents"
  // rows (live-test finding, thread 7ac7ef05).
  const groupKeyByTaskId = new Map<string, string>();
  for (const entry of entries) {
    const isTaskRow =
      entry.taskId !== undefined &&
      !entry.isBackgroundTask &&
      (entry.activityKind === "task.started" ||
        entry.activityKind === "task.progress" ||
        entry.activityKind === "task.completed");
    if (isTaskRow && entry.taskId !== undefined) {
      const rememberedKey = groupKeyByTaskId.get(entry.taskId);
      const groupKey = rememberedKey ?? agentSpawnGroupKey(entry);
      if (rememberedKey === undefined) {
        groupKeyByTaskId.set(entry.taskId, groupKey);
      }
      const workflowId = groupKey.startsWith("wf:") ? groupKey.slice(3) : null;
      const existingIndex = spawnRowIndex.get(groupKey);
      if (existingIndex !== undefined) {
        const existing = collapsed[existingIndex]!;
        const agentTaskIds = existing.agentSpawn?.agentTaskIds.includes(entry.taskId)
          ? existing.agentSpawn.agentTaskIds
          : [...(existing.agentSpawn?.agentTaskIds ?? []), entry.taskId];
        collapsed[existingIndex] = {
          ...mergeDerivedWorkLogEntries(existing, entry),
          // The CTA row keeps the group's ANCHOR identity, not the last
          // agent's: id/createdAt/turnId stay pinned to the spawn point so
          // the row renders where the run launched instead of drifting to
          // the newest progress tick (mid-run it drifted below the whole
          // conversation, reading as "no visualization"), and the stable id
          // keeps React state/virtualization sane.
          id: existing.id,
          createdAt: existing.createdAt,
          turnId: existing.turnId ?? null,
          ...(existing.taskId !== undefined ? { taskId: existing.taskId } : {}),
          label: existing.label,
          agentSpawn: { workflowId, agentTaskIds },
        };
        continue;
      }
      spawnRowIndex.set(groupKey, collapsed.length);
      collapsed.push({
        ...entry,
        agentSpawn: { workflowId, agentTaskIds: [entry.taskId] },
      });
      continue;
    }
    const previous = collapsed.at(-1);
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      collapsed[collapsed.length - 1] = mergeDerivedWorkLogEntries(previous, entry);
      continue;
    }
    collapsed.push(entry);
  }
  return collapsed;
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
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const itemType = next.itemType ?? previous.itemType;
  const requestKind = next.requestKind ?? previous.requestKind;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const toolCallId = next.toolCallId ?? previous.toolCallId;
  const toolLifecycleStatus = next.toolLifecycleStatus ?? previous.toolLifecycleStatus;
  const toolData = next.toolData ?? previous.toolData;
  const toolName = next.toolName ?? previous.toolName;
  const toolInput = next.toolInput ?? previous.toolInput;
  // Prefer a diff with real line numbers (from the tool result) over a
  // reconstructed streaming diff, regardless of arrival order.
  const toolDiff =
    next.toolDiff && next.toolDiff.hunks.some((hunk) => hunk.oldStart !== null)
      ? next.toolDiff
      : previous.toolDiff && previous.toolDiff.hunks.some((hunk) => hunk.oldStart !== null)
        ? previous.toolDiff
        : (next.toolDiff ?? previous.toolDiff);
  return {
    ...previous,
    ...next,
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(rawCommand ? { rawCommand } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolLifecycleStatus !== undefined ? { toolLifecycleStatus } : {}),
    ...(toolData !== undefined ? { toolData } : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolInput ? { toolInput } : {}),
    ...(toolDiff ? { toolDiff } : {}),
    ...((next.toolResultText ?? previous.toolResultText)
      ? { toolResultText: next.toolResultText ?? previous.toolResultText }
      : {}),
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
  // Subagent lifecycle rows collapse by agent identity: one row per agent,
  // progress ticks fold into it, the terminal row wins the label.
  if (
    entry.taskId &&
    (entry.activityKind === "task.progress" || entry.activityKind === "task.completed")
  ) {
    return `task${entry.taskId}`;
  }
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

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

function extractToolName(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const direct = asTrimmedString(data?.toolName);
  if (direct) {
    return direct;
  }
  // ACP harnesses surface dynamic tools with the tool name as `rawInput.variant`.
  return asTrimmedString(asRecord(data?.rawInput)?.variant);
}

function extractToolInput(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  const data = asRecord(payload?.data);
  return asRecord(data?.input) ?? asRecord(data?.rawInput) ?? asRecord(asRecord(data?.item)?.input);
}

const MAX_TOOL_DIFF_LINES = 400;
const MAX_TOOL_RESULT_TEXT = 4000;

function truncateToolResultText(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > MAX_TOOL_RESULT_TEXT
    ? `${trimmed.slice(0, MAX_TOOL_RESULT_TEXT)}…`
    : trimmed;
}

function textFromContentBlocks(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content.flatMap((block) => {
    const record = asRecord(block);
    return typeof record?.text === "string" ? [record.text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

function extractToolResultText(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const result = asRecord(data?.result);
  if (!result) {
    return null;
  }
  return truncateToolResultText(textFromContentBlocks(result.content));
}

function splitDiffContent(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function parseStructuredPatch(value: unknown): WorkLogToolDiffHunk[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const hunks: WorkLogToolDiffHunk[] = [];
  for (const rawHunk of value) {
    const hunk = asRecord(rawHunk);
    if (!hunk || !Array.isArray(hunk.lines)) {
      return null;
    }
    const lines = hunk.lines.filter((line): line is string => typeof line === "string");
    if (lines.length === 0) {
      continue;
    }
    hunks.push({
      oldStart: asNumber(hunk.oldStart),
      newStart: asNumber(hunk.newStart),
      lines,
    });
  }
  return hunks.length > 0 ? hunks : null;
}

function capToolDiff(filePath: string | null, hunks: WorkLogToolDiffHunk[]): WorkLogToolDiff {
  let remaining = MAX_TOOL_DIFF_LINES;
  let truncated = false;
  const capped: WorkLogToolDiffHunk[] = [];
  for (const hunk of hunks) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (hunk.lines.length <= remaining) {
      capped.push(hunk);
      remaining -= hunk.lines.length;
      continue;
    }
    capped.push({ ...hunk, lines: hunk.lines.slice(0, remaining) });
    remaining = 0;
    truncated = true;
  }
  return { filePath, hunks: capped, truncated };
}

function reconstructedEditHunk(oldText: string, newText: string): WorkLogToolDiffHunk | null {
  const lines = [
    ...splitDiffContent(oldText).map((line) => `-${line}`),
    ...splitDiffContent(newText).map((line) => `+${line}`),
  ];
  if (lines.length === 0) {
    return null;
  }
  return { oldStart: null, newStart: null, lines };
}

const FILE_EDIT_TOOL_NAME =
  /^(edit|multiedit|write|notebookedit|str_replace.*|create_file|apply_?patch|edit_file|write_file|update_file)$/i;

/**
 * Parse a unified-diff string (as emitted by Codex `fileChange` items and
 * patch-style edit tools) into displayable hunks with real line numbers.
 */
function parseUnifiedDiffHunks(diff: string): WorkLogToolDiffHunk[] {
  interface MutableHunk {
    oldStart: number | null;
    newStart: number | null;
    lines: string[];
  }
  const hunks: MutableHunk[] = [];
  let current: MutableHunk | null = null;
  const rawLines = diff.split("\n");
  if (rawLines.at(-1) === "") {
    rawLines.pop();
  }
  for (const line of rawLines) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith("\\")) {
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "") {
      current.lines.push(line);
    }
  }
  return hunks.filter((hunk) => hunk.lines.length > 0);
}

/**
 * Diff for file-edit tools: prefer the provider's structured patch (real line
 * numbers, present once the tool result lands); otherwise reconstruct a
 * numberless old/new block from the streaming tool input so edits are visible
 * live while the tool call is still in flight.
 */
function extractToolDiff(
  payload: Record<string, unknown> | null,
  toolName: string | null,
  toolInput: Record<string, unknown> | null,
): WorkLogToolDiff | null {
  const data = asRecord(payload?.data);
  const toolUseResult = asRecord(data?.toolUseResult);
  const filePath =
    asTrimmedString(toolUseResult?.filePath) ?? asTrimmedString(toolInput?.file_path);

  const structured = parseStructuredPatch(toolUseResult?.structuredPatch);
  if (structured) {
    return capToolDiff(filePath, structured);
  }

  if (!toolName || !FILE_EDIT_TOOL_NAME.test(toolName) || !toolInput) {
    return null;
  }

  const edits = Array.isArray(toolInput.edits) ? toolInput.edits : null;
  if (edits) {
    const hunks: WorkLogToolDiffHunk[] = [];
    for (const rawEdit of edits) {
      const edit = asRecord(rawEdit);
      const oldText = typeof edit?.old_string === "string" ? edit.old_string : null;
      const newText = typeof edit?.new_string === "string" ? edit.new_string : null;
      if (oldText === null || newText === null) {
        continue;
      }
      const hunk = reconstructedEditHunk(oldText, newText);
      if (hunk) {
        hunks.push(hunk);
      }
    }
    return hunks.length > 0 ? capToolDiff(filePath, hunks) : null;
  }

  const oldText = typeof toolInput.old_string === "string" ? toolInput.old_string : null;
  const newText = typeof toolInput.new_string === "string" ? toolInput.new_string : null;
  if (oldText !== null && newText !== null) {
    const hunk = reconstructedEditHunk(oldText, newText);
    return hunk ? capToolDiff(filePath, [hunk]) : null;
  }

  const content = typeof toolInput.content === "string" ? toolInput.content : null;
  if (content !== null) {
    const lines = splitDiffContent(content).map((line) => `+${line}`);
    if (lines.length === 0) {
      return null;
    }
    return capToolDiff(filePath, [{ oldStart: null, newStart: 1, lines }]);
  }

  // Patch-style edit tools (apply_patch and friends) pass a unified diff.
  const patchText = [toolInput.diff, toolInput.patch].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );
  if (patchText !== undefined) {
    const hunks = parseUnifiedDiffHunks(patchText);
    if (hunks.length > 0) {
      return capToolDiff(filePath, hunks);
    }
  }

  return null;
}

interface NormalizedProviderToolCall {
  toolName: string;
  toolInput: Record<string, unknown> | null;
  toolResultText: string | null;
  toolDiff: WorkLogToolDiff | null;
}

/**
 * Codex forwards its native thread item verbatim in `data.item` without the
 * `toolName`/`input` envelope Claude uses. Synthesize the same normalized
 * fields from the item so Codex tool calls render with the styled
 * `Tool(arg)` headers, inline diffs, and result lines.
 */
function normalizeCodexToolItem(
  payload: Record<string, unknown> | null,
): NormalizedProviderToolCall | null {
  const item = asRecord(asRecord(payload?.data)?.item);
  const type = asTrimmedString(item?.type);
  if (!item || !type) {
    return null;
  }
  switch (type) {
    case "commandExecution": {
      const command = asTrimmedString(item.command);
      return {
        toolName: "Shell",
        toolInput: command ? { command } : null,
        toolResultText: truncateToolResultText(
          typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : null,
        ),
        toolDiff: null,
      };
    }
    case "fileChange": {
      const changes = (Array.isArray(item.changes) ? item.changes : []).flatMap((change) => {
        const record = asRecord(change);
        return record ? [record] : [];
      });
      const kinds = changes.map((change) => asTrimmedString(change.kind));
      const firstPath = changes.length > 0 ? asTrimmedString(changes[0]?.path) : null;
      const hunks = changes.flatMap((change) =>
        typeof change.diff === "string" ? parseUnifiedDiffHunks(change.diff) : [],
      );
      return {
        toolName: kinds.length > 0 && kinds.every((kind) => kind === "add") ? "Write" : "Edit",
        toolInput: firstPath
          ? {
              file_path:
                changes.length > 1 ? `${firstPath} (+${changes.length - 1} more)` : firstPath,
            }
          : null,
        toolResultText: null,
        toolDiff: hunks.length > 0 ? capToolDiff(firstPath, hunks) : null,
      };
    }
    case "mcpToolCall": {
      const tool = asTrimmedString(item.tool);
      const server = asTrimmedString(item.server);
      const result = asRecord(item.result);
      return {
        toolName: tool ?? "MCP tool",
        toolInput: asRecord(item.arguments) ?? (server ? { server } : null),
        toolResultText: truncateToolResultText(textFromContentBlocks(result?.content)),
        toolDiff: null,
      };
    }
    case "dynamicToolCall": {
      const tool = asTrimmedString(item.tool);
      return {
        toolName: tool ?? "Tool",
        toolInput: asRecord(item.arguments),
        toolResultText: truncateToolResultText(textFromContentBlocks(item.contentItems)),
        toolDiff: null,
      };
    }
    case "webSearch": {
      const query = asTrimmedString(item.query);
      return {
        toolName: "WebSearch",
        toolInput: query ? { query } : null,
        toolResultText: null,
        toolDiff: null,
      };
    }
    case "imageView": {
      const path = asTrimmedString(item.path);
      return {
        toolName: "Read",
        toolInput: path ? { file_path: path } : null,
        toolResultText: null,
        toolDiff: null,
      };
    }
    case "collabAgentToolCall": {
      const tool = asTrimmedString(item.tool);
      const prompt = asTrimmedString(item.prompt);
      return {
        toolName: tool ?? "Agent",
        toolInput: prompt ? { prompt } : null,
        toolResultText: null,
        toolDiff: null,
      };
    }
    default:
      return null;
  }
}

function acpToolResultText(data: Record<string, unknown>): string | null {
  const chunks: string[] = [];
  if (Array.isArray(data.content)) {
    for (const entry of data.content) {
      const record = asRecord(entry);
      if (record?.type !== "content") {
        continue;
      }
      const nested = asRecord(record.content);
      if (typeof nested?.text === "string" && nested.text.trim().length > 0) {
        chunks.push(nested.text);
      }
    }
  }
  if (chunks.length === 0) {
    if (typeof data.rawOutput === "string") {
      chunks.push(data.rawOutput);
    } else {
      const rawOutput = asRecord(data.rawOutput);
      const text =
        textFromContentBlocks(rawOutput?.content) ??
        asTrimmedString(rawOutput?.output) ??
        asTrimmedString(rawOutput?.stdout);
      if (text) {
        chunks.push(text);
      }
    }
  }
  return truncateToolResultText(chunks.join("\n"));
}

const ACP_DIFF_CONTEXT_LINES = 3;

/**
 * ACP diff content carries whole old/new text blobs (often the full file).
 * Reduce them to a contextual hunk by trimming the common line prefix/suffix
 * so edits render like Claude's structured patches instead of a full-file
 * remove/add wall.
 */
function contextualDiffHunk(oldText: string, newText: string): WorkLogToolDiffHunk | null {
  const oldLines = splitDiffContent(oldText);
  const newLines = splitDiffContent(newText);
  if (oldLines.length === 0) {
    return reconstructedEditHunk(oldText, newText);
  }
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  if (removed.length === 0 && added.length === 0) {
    return null;
  }
  const contextStart = Math.max(0, prefix - ACP_DIFF_CONTEXT_LINES);
  const leadingContext = oldLines.slice(contextStart, prefix).map((line) => ` ${line}`);
  const trailingContext = oldLines
    .slice(oldLines.length - suffix, oldLines.length - suffix + ACP_DIFF_CONTEXT_LINES)
    .map((line) => ` ${line}`);
  return {
    oldStart: contextStart + 1,
    newStart: contextStart + 1,
    lines: [
      ...leadingContext,
      ...removed.map((line) => `-${line}`),
      ...added.map((line) => `+${line}`),
      ...trailingContext,
    ],
  };
}

function acpContentDiff(data: Record<string, unknown>): WorkLogToolDiff | null {
  if (!Array.isArray(data.content)) {
    return null;
  }
  const hunks: WorkLogToolDiffHunk[] = [];
  let filePath: string | null = null;
  for (const entry of data.content) {
    const record = asRecord(entry);
    if (record?.type !== "diff") {
      continue;
    }
    filePath ??= asTrimmedString(record.path);
    const hunk = contextualDiffHunk(
      typeof record.oldText === "string" ? record.oldText : "",
      typeof record.newText === "string" ? record.newText : "",
    );
    if (hunk) {
      hunks.push(hunk);
    }
  }
  return hunks.length > 0 ? capToolDiff(filePath, hunks) : null;
}

function acpFirstLocationPath(data: Record<string, unknown>): string | null {
  if (!Array.isArray(data.locations)) {
    return null;
  }
  for (const entry of data.locations) {
    const path = asTrimmedString(asRecord(entry)?.path);
    if (path) {
      return path;
    }
  }
  return null;
}

/**
 * ACP providers (cursor/grok/opencode/slave) surface tool calls as
 * `{toolCallId, kind, command, rawInput, rawOutput, content, locations}`
 * without a tool-name envelope. Some stamp the tool name in
 * `rawInput.variant` (handled by extractToolName); the rest are classified
 * here from the ACP tool kind and raw-input shape so they still render as
 * styled `Tool(arg)` rows with result lines and diffs.
 */
function normalizeAcpToolCall(
  payload: Record<string, unknown> | null,
): NormalizedProviderToolCall | null {
  const data = asRecord(payload?.data);
  if (
    !data ||
    !asTrimmedString(data.toolCallId) ||
    data.toolName !== undefined ||
    data.item !== undefined
  ) {
    return null;
  }
  const rawInput = asRecord(data.rawInput);
  const kind = asTrimmedString(data.kind);
  const itemType = asTrimmedString(payload?.itemType);
  const toolResultText = acpToolResultText(data);
  const toolDiff = acpContentDiff(data);

  const command = asTrimmedString(data.command) ?? asTrimmedString(rawInput?.command);
  if (command && kind !== "edit" && itemType !== "file_change") {
    return { toolName: "Shell", toolInput: { command }, toolResultText, toolDiff: null };
  }

  const filePath =
    asTrimmedString(rawInput?.file_path) ??
    asTrimmedString(rawInput?.path) ??
    asTrimmedString(rawInput?.target_file) ??
    asTrimmedString(toolDiff?.filePath) ??
    acpFirstLocationPath(data);
  const fileInput = filePath ? { file_path: filePath } : null;

  if (kind === "edit" || kind === "move" || kind === "delete" || itemType === "file_change") {
    const isCreate =
      toolDiff === null &&
      typeof rawInput?.content === "string" &&
      rawInput.old_string === undefined;
    return {
      toolName: isCreate ? "Write" : "Edit",
      toolInput: fileInput,
      toolResultText,
      toolDiff,
    };
  }
  if (toolDiff) {
    return { toolName: "Edit", toolInput: fileInput, toolResultText, toolDiff };
  }
  if (kind === "read") {
    return { toolName: "Read", toolInput: fileInput, toolResultText, toolDiff: null };
  }
  if (kind === "search" || itemType === "web_search") {
    const pattern = asTrimmedString(rawInput?.pattern);
    if (pattern) {
      return { toolName: "Grep", toolInput: { pattern }, toolResultText, toolDiff: null };
    }
    const query = asTrimmedString(rawInput?.query) ?? asTrimmedString(rawInput?.url);
    return {
      toolName: "WebSearch",
      toolInput: query ? { query } : null,
      toolResultText,
      toolDiff: null,
    };
  }
  if (kind === "fetch") {
    const url = asTrimmedString(rawInput?.url) ?? asTrimmedString(rawInput?.query);
    return {
      toolName: "WebFetch",
      toolInput: url ? { url } : null,
      toolResultText,
      toolDiff: null,
    };
  }
  return null;
}

function extractToolCallId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  // Claude ingestion stamps toolCallId on the payload root; other providers
  // nest it in the passthrough data record.
  return asTrimmedString(data?.toolCallId) ?? asTrimmedString(payload?.toolCallId);
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

export function summarizeToolTextOutput(value: string): string | null {
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
