import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  ProviderApprovalOption,
  ProviderRequestKind,
} from "@t3tools/contracts";
import type {
  OrchestrationLatestTurn,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ToolLifecycleItemType,
  TurnId,
  UserInputQuestion,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  commandDetailRepeatsCommand,
  extractCommandOutputText,
  isWorktreeSetupActivity,
  liveActivityToolStatus,
  normalizeCompactToolLabel,
  omitSupersededLifecycleMarkers,
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  type ToolGroupSummaryKind,
} from "@t3tools/client-runtime/work-log/presentation";
import { extractToolActivityPresentation } from "@t3tools/client-runtime/work-log/tool-presentation";
import { commandProgramName } from "@t3tools/client-runtime/work-log/command-label";

import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";

export interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly createdAt: string;
  readonly detail?: string;
  readonly appName?: string;
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
}

const isProviderRequestKind = Schema.is(ProviderRequestKind);
const isProviderApprovalOption = Schema.is(ProviderApprovalOption);

export interface PendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
}

export interface PendingUserInputDraftAnswer {
  readonly selectedOptionValues?: ReadonlyArray<string>;
  readonly customAnswer?: string;
}

export interface ThreadFeedActivity {
  readonly id: string;
  readonly createdAt: string;
  readonly turnId: TurnId | null;
  readonly summary: string;
  readonly detail: string | null;
  readonly canExpand: boolean;
  readonly getFullDetail: () => string | null;
  readonly getCopyText: () => string;
  readonly icon:
    | "agent"
    | "alert"
    | "browser"
    | "check"
    | "command"
    | "computer"
    | "edit"
    | "eye"
    | "globe"
    | "hammer"
    | "message"
    | "warning"
    | "wrench"
    | "zap";
  readonly toolLike: boolean;
  readonly status: "success" | "failure" | "neutral" | null;
  readonly lifecycleStatus?: WorkLogToolLifecycleStatus;
  readonly workEntry: WorkLogEntry;
  readonly groupedToolDetail?: boolean;
  readonly live?: boolean;
}

type WorkLogToolLifecycleStatus = "inProgress" | "completed" | "failed" | "declined" | "stopped";

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  turnId: TurnId | null;
  label: string;
  detail?: string;
  viewedImagePath?: string;
  command?: string;
  rawCommand?: string;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  toolSurface?: import("@t3tools/contracts").ToolActivitySurface;
  toolIcon?: import("@t3tools/contracts").ToolActivityIcon;
  toolSource?: import("@t3tools/contracts").ToolActivitySource;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  sourceActivityKind?: OrchestrationThreadActivity["kind"];
  toolCallId?: string;
  /**
   * One row per workflow run or per-turn batch of direct spawns, like web's
   * "Kicked off N subagents" CTA. Mobile has no Agents sheet, so the row
   * also carries each agent's terminal state to derive its status label.
   */
  agentSpawn?: {
    readonly workflowId: string | null;
    readonly agentTaskIds: ReadonlyArray<string>;
    readonly agents: ReadonlyArray<{
      readonly title: string;
      readonly status: WorkLogToolLifecycleStatus | undefined;
      readonly detail: string | undefined;
      /** When this member last reported, so the card can show the newest activity. */
      readonly updatedAt: string;
    }>;
  };
  toolData?: unknown;
}

interface DerivedWorkLogEntry extends WorkLogEntry {
  sourceActivityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
  /** Grouping key for subagent lifecycle rows (one row per agent). */
  taskId?: string;
  /** The tool call that launched this agent, when the provider reports one. */
  agentSpawnToolCallId?: string;
  isWorkflowCoordinator?: boolean;
  /** Shell/monitor/plan tasks: ordinary work-log rows, never spawn batches. */
  isBackgroundTask?: boolean;
}

type RawThreadFeedEntry =
  | {
      readonly type: "message";
      readonly id: string;
      readonly createdAt: string;
      readonly message: OrchestrationThread["messages"][number];
    }
  | {
      readonly type: "activity";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId | null;
      readonly activity: ThreadFeedActivity;
    };

export type ThreadFeedEntry =
  | Extract<RawThreadFeedEntry, { type: "message" }>
  | {
      readonly type: "activity-group";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId | null;
      readonly activities: ReadonlyArray<ThreadFeedActivity>;
    }
  | {
      readonly type: "work-toggle";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId | null;
      readonly groupId: string;
      readonly hiddenCount: number;
      readonly expanded: boolean;
      readonly summary: string;
      readonly summaryKind: ToolGroupSummaryKind;
      readonly toolSurface?: WorkLogEntry["toolSurface"];
      readonly toolIcon?: WorkLogEntry["toolIcon"];
      readonly summaryToolIcon?: "browser" | "t3-code";
      readonly hasFailure: boolean;
      readonly live: boolean;
      readonly shimmer: boolean;
    }
  | {
      readonly type: "turn-fold";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId;
      readonly label: string;
      readonly expanded: boolean;
    }
  | {
      /**
       * The turn's single live slot. Web keys its live tool row and its
       * "Thinking" row identically so the slot updates in place; here the
       * slot holds "Thinking" whenever no tool row is shimmering, so a tool
       * failing does not insert a row under the group it lives in.
       */
      readonly type: "thinking";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId | null;
    }
  | {
      /**
       * One batch of spawned subagents. Rendered as its own card because a
       * single-line tool row has no room for what the agents are doing now,
       * which on a phone is the one thing worth showing.
       */
      readonly type: "agent-spawn";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId | null;
      readonly activity: ThreadFeedActivity;
      readonly expanded: boolean;
      readonly summary: AgentSpawnSummary;
    };

export interface AgentSpawnSummary {
  /** "Locate UNO hand rendering code" for one agent, "3 subagents" for a batch. */
  readonly title: string;
  /** Latest member activity while working, else the batch outcome. */
  readonly status: string;
  readonly tone: "working" | "completed" | "failed" | "stopped";
  readonly members: ReadonlyArray<{
    readonly title: string;
    readonly status: string;
    readonly tone: "working" | "completed" | "failed" | "stopped";
    readonly detail: string | undefined;
    readonly updatedAt: string;
  }>;
}

export type ThreadFeedLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;

type ThreadFeedActivityGroup = Extract<ThreadFeedEntry, { readonly type: "activity-group" }>;

// These keys are immutable inputs. Weak caches release old histories with their source data.
const activityEntriesCache = new WeakMap<
  ReadonlyArray<OrchestrationThreadActivity>,
  ReadonlyArray<Extract<RawThreadFeedEntry, { readonly type: "activity" }>>
>();
const messageEntriesCache = new WeakMap<
  OrchestrationThread["messages"][number],
  Extract<RawThreadFeedEntry, { readonly type: "message" }>
>();
const activityGroupsCache = new WeakMap<ThreadFeedActivity, ThreadFeedActivityGroup>();
const presentedActivityGroupsCache = new WeakMap<
  ThreadFeedActivityGroup,
  {
    readonly unsettledTurnId: TurnId | null;
    readonly isWorking: boolean;
    readonly activeTail: boolean;
    readonly rows: ReadonlyArray<ThreadFeedEntry>;
  }
>();
const turnFoldRowsCache = new WeakMap<
  ThreadFeedEntry,
  Extract<ThreadFeedEntry, { readonly type: "turn-fold" }>
>();
let cachedThinkingRow: Extract<ThreadFeedEntry, { readonly type: "thinking" }> | null = null;

export function isContextCompactionActivityGroup(
  entry: Extract<ThreadFeedEntry, { readonly type: "activity-group" }>,
): boolean {
  return (
    entry.activities.length === 1 &&
    entry.activities[0]?.workEntry.sourceActivityKind === "context-compaction"
  );
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
    case "mcp_elicitation_approval":
      return "mcp-elicitation";
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

function parseApprovalRequestId(value: unknown): ApprovalRequestId | null {
  return typeof value === "string" && value.length > 0 ? ApprovalRequestId.make(value) : null;
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
          const record = option as Record<string, unknown>;
          if (typeof record.label !== "string" || typeof record.description !== "string") {
            return null;
          }
          return {
            label: record.label,
            description: record.description,
            ...(typeof record.value === "string" ? { value: record.value } : {}),
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      if (options.length === 0 && question.allowCustomAnswer === false) {
        return null;
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
        multiSelect: question.multiSelect === true,
        ...(typeof question.allowCustomAnswer === "boolean"
          ? { allowCustomAnswer: question.allowCustomAnswer }
          : {}),
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);

  return parsed.length > 0 ? parsed : null;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolvePendingUserInputOptionValue(
  question: UserInputQuestion,
  value: string,
): string | null {
  if (question.options.some((option) => option.value === value)) {
    return value;
  }

  const label = value.trim();
  return label.length > 0 &&
    question.options.some((option) => option.value === undefined && option.label.trim() === label)
    ? label
    : null;
}

function normalizeSelectedOptionValues(
  question: UserInputQuestion,
  value: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((entry) => resolvePendingUserInputOptionValue(question, entry))
        .filter((entry): entry is string => entry !== null),
    ),
  );
}

function resolvePendingUserInputAnswer(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | ReadonlyArray<string> | null {
  const customAnswer =
    question.allowCustomAnswer === false ? null : normalizeDraftAnswer(draft?.customAnswer);
  if (customAnswer) {
    return customAnswer;
  }

  const selectedOptionValues = normalizeSelectedOptionValues(question, draft?.selectedOptionValues);
  if (question.multiSelect) {
    return selectedOptionValues.length > 0 ? selectedOptionValues : null;
  }
  return selectedOptionValues[0] ?? null;
}

/** Some providers settle agents through task.updated instead of task.completed. */
const MOBILE_TERMINAL_UPDATE_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function isTerminalTaskUpdate(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "task.updated") {
    return false;
  }
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return (
    typeof payload?.status === "string" &&
    (MOBILE_TERMINAL_UPDATE_STATUSES.has(payload.status) ||
      (payload.timelineBypass === true && payload.status === "idle"))
  );
}

/**
 * Quiet-timeline guarantee (mirrors web's session-logic): agent-internal
 * activity lives in the Agents sheet, not the work log. Agent lifecycle rows
 * pass even when bypassed or owned by another agent, because they fold into
 * their spawn batch rather than rendering on their own; that is how Codex
 * children (all bypassed) and Claude workflow members reach the batch row.
 * Terminal rows are kept regardless — with no Agents surface on mobile they
 * are the terminal signal.
 */
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
  const ownedByAgent = typeof payload.agentId === "string" && payload.agentId.trim().length > 0;
  if (isTaskRow) {
    if (!ownedByAgent && payload.timelineBypass !== true) {
      return false;
    }
    // An agent's own shells stay internal; the agents themselves fold into
    // their batch. A bypassed batch marker keeps its terminal row.
    if (typeof payload.taskId === "string" && payload.agentKind === "agent") {
      return false;
    }
    if (ownedByAgent) {
      return true;
    }
    return !(activity.kind === "task.completed" || isTerminalTaskUpdate(activity));
  }
  return payload.timelineBypass === true || ownedByAgent;
}

/** Agent (non-background) task.started rows seed spawn batches. */
function isAgentTaskStartedActivity(activity: OrchestrationThreadActivity): boolean {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return typeof payload?.taskId === "string" && payload.agentKind === "agent";
}

function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): DerivedWorkLogEntry[] {
  const ordered = Arr.sort(activities, activityOrder);
  const entries: DerivedWorkLogEntry[] = [];
  for (const activity of ordered) {
    if (activity.tone !== "error" && isWorktreeSetupActivity(activity.kind)) continue;
    if (activity.kind === "tool.started") continue;
    // Like web: an agent's task.started row anchors its batch. It has a fixed
    // id and timestamp, unlike progress ticks, whose stable per-task id is
    // rewritten with a new createdAt on every update (and would otherwise
    // make the batch row a "fresh" row again on each tick).
    if (activity.kind === "task.started" && !isAgentTaskStartedActivity(activity)) continue;
    if (activity.kind === "task.updated" && !isTerminalTaskUpdate(activity)) continue;
    if (activity.kind === "tool.progress") continue;
    if (activity.kind === "context-window.updated") continue;
    if (activity.summary === "Checkpoint captured") continue;
    if (isNoContentRuntimeWarning(activity)) continue;
    if (isPlanBoundaryToolActivity(activity)) continue;
    if (isAgentInternalActivity(activity)) continue;
    entries.push(toDerivedWorkLogEntry(activity));
  }
  return collapseDerivedWorkLogEntries(entries);
}

/** Adapters forward unknown wire-only SDK messages (background_tasks_changed,
 *  commands_changed, ...) as runtime warnings. The suffix comes from
 *  describeUnknownSdkMessage in the Claude adapter; a row with no displayable
 *  text carries nothing a user can act on, so it does not render. */
function isNoContentRuntimeWarning(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.kind === "runtime.warning" &&
    activity.summary.endsWith("(no displayable text content)")
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

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const commandPreview = extractToolCommand(payload);
  const changedFiles = extractChangedFiles(payload);
  const title = extractToolTitle(payload);
  const toolPresentation = extractToolActivityPresentation(payload);
  // Terminal task updates carry identity so they replace each child's progress row.
  const isTaskActivity =
    activity.kind === "task.started" ||
    activity.kind === "task.progress" ||
    activity.kind === "task.completed" ||
    activity.kind === "task.updated";
  const taskSummary =
    isTaskActivity && typeof payload?.summary === "string" && payload.summary.length > 0
      ? payload.summary
      : null;
  const taskDetailAsLabel =
    isTaskActivity &&
    !taskSummary &&
    !title &&
    typeof payload?.detail === "string" &&
    payload.detail.length > 0
      ? payload.detail
      : null;
  const taskLabel = taskSummary || taskDetailAsLabel;
  const taskId =
    isTaskActivity && typeof payload?.taskId === "string" && payload.taskId.length > 0
      ? payload.taskId
      : undefined;
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    ...(taskId ? { taskId } : {}),
    label: taskLabel || activity.summary,
    tone:
      activity.kind === "task.progress"
        ? "thinking"
        : activity.tone === "approval"
          ? "info"
          : activity.tone,
    sourceActivityKind: activity.kind,
  };
  const toolCallId =
    asTrimmedString(payload?.toolCallId) ?? asTrimmedString(asRecord(payload?.data)?.toolCallId);
  if (toolCallId) {
    entry.toolCallId = toolCallId;
  }
  if (isTaskActivity && payload) {
    if (payload.agentKind !== "agent") {
      entry.isBackgroundTask = true;
    }
    const spawnToolCallId = asTrimmedString(payload.toolUseId);
    if (spawnToolCallId) {
      entry.agentSpawnToolCallId = spawnToolCallId;
    }
    if (
      payload.taskType === "local_workflow" ||
      (typeof payload.workflowName === "string" && payload.workflowName.length > 0)
    ) {
      entry.isWorkflowCoordinator = true;
    }
  }
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  const viewedImagePath = asTrimmedString(asRecord(payload?.data)?.imagePath);
  const commandOutput = commandPreview.command ? extractCommandOutputText(payload?.data) : null;
  const output = commandOutput ? stripTrailingExitCode(commandOutput).output : null;
  if (!taskDetailAsLabel && output) {
    entry.detail = output;
  } else if (!taskDetailAsLabel && typeof payload?.detail === "string") {
    const detail = stripTrailingExitCode(payload.detail).output;
    const data = asRecord(payload.data);
    const repeatsCommand =
      detail !== null &&
      commandDetailRepeatsCommand({
        detail,
        command: commandPreview.command,
        rawCommand: commandPreview.rawCommand,
        toolName: data?.toolName,
        data,
      });
    if (detail && detail !== title && !repeatsCommand) entry.detail = detail;
  }
  if (isTaskActivity && typeof payload?.error === "string" && payload.error.trim()) {
    entry.detail = payload.error;
  }
  if (viewedImagePath) {
    entry.viewedImagePath = viewedImagePath;
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
  if (toolPresentation.toolSurface) {
    entry.toolSurface = toolPresentation.toolSurface;
  }
  if (toolPresentation.toolIcon) {
    entry.toolIcon = toolPresentation.toolIcon;
  }
  if (toolPresentation.toolSource) {
    entry.toolSource = toolPresentation.toolSource;
  }
  if (itemType === "mcp_tool_call") {
    const data = asRecord(payload?.data);
    const toolData = typeof data?.toolName === "string" ? (data.item ?? data) : data?.item;
    if (toolData !== undefined) {
      entry.toolData = toolData;
    }
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  let toolLifecycleStatus = extractWorkLogToolLifecycleStatus(payload);
  if (
    !toolLifecycleStatus &&
    (activity.kind === "tool.completed" || activity.kind === "task.completed")
  ) {
    toolLifecycleStatus = activity.tone === "error" ? "failed" : "completed";
  }
  // A Codex child that finishes its turn reports "idle" (resumable, not
  // terminal). For the batch row that is a finished member.
  if (!toolLifecycleStatus && isTaskActivity && payload?.status === "idle") {
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

/**
 * Spawn-group key for a subagent lifecycle row. Workflow members and their
 * coordinator share the coordinator's group; direct spawns batch per turn.
 * Same keys as web's session-logic so both clients fold the same rows.
 */
function agentSpawnGroupKey(entry: DerivedWorkLogEntry): string {
  const taskId = entry.taskId ?? "";
  const workflowSlot = taskId.indexOf(":wf:");
  if (workflowSlot !== -1) return `wf:${taskId.slice(0, workflowSlot)}`;
  if (entry.isWorkflowCoordinator) return `wf:${taskId}`;
  return entry.turnId ? `direct:${entry.turnId}` : `direct:task:${taskId}`;
}

/**
 * The batch row keeps the group's anchor identity (id, createdAt, turnId,
 * label) so it renders where the run launched instead of drifting to the
 * newest progress tick, and gains each member's latest lifecycle state.
 */
function agentSpawnRow(
  anchor: DerivedWorkLogEntry,
  workflowId: string | null,
  agentTaskIds: ReadonlyArray<string>,
  members: NonNullable<WorkLogEntry["agentSpawn"]>["agents"],
): DerivedWorkLogEntry {
  // A finished coordinator settles members that never reported their own
  // end; Claude stops synthesizing member ticks once the workflow is done.
  const coordinator = workflowId === null ? undefined : members[agentTaskIds.indexOf(workflowId)];
  const agents =
    coordinator?.status !== undefined && coordinator.status !== "inProgress"
      ? members.map((agent) =>
          agent.status === undefined || agent.status === "inProgress"
            ? { ...agent, status: coordinator.status }
            : agent,
        )
      : members;
  const agentSpawn = { workflowId, agentTaskIds, agents };
  // The batch row has no detail of its own: its body lists the members.
  const { detail: _detail, ...anchorWithoutDetail } = anchor;
  return {
    ...anchorWithoutDetail,
    // The row's own lifecycle is the batch's: live while any member is, then
    // the worst terminal state, so the group summary and shimmer follow it.
    toolLifecycleStatus: agentSpawnLifecycleStatus(agents),
    agentSpawn,
  };
}

function agentSpawnMember(
  entry: DerivedWorkLogEntry,
  previous?: NonNullable<WorkLogEntry["agentSpawn"]>["agents"][number],
) {
  return {
    title: entry.toolTitle ?? previous?.title ?? entry.label,
    status: entry.toolLifecycleStatus ?? previous?.status,
    detail: entry.detail ?? previous?.detail,
    updatedAt: entry.createdAt,
  };
}

function mergeAgentSpawnEntries(
  existing: DerivedWorkLogEntry,
  entry: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const spawn = existing.agentSpawn!;
  const taskId = entry.taskId ?? "";
  const memberIndex = spawn.agentTaskIds.indexOf(taskId);
  if (memberIndex === -1) {
    return agentSpawnRow(
      existing,
      spawn.workflowId,
      [...spawn.agentTaskIds, taskId],
      [...spawn.agents, agentSpawnMember(entry)],
    );
  }
  const agents = spawn.agents.map((agent, index) =>
    index === memberIndex ? agentSpawnMember(entry, agent) : agent,
  );
  return agentSpawnRow(existing, spawn.workflowId, spawn.agentTaskIds, agents);
}

function agentSpawnLifecycleStatus(
  agents: NonNullable<WorkLogEntry["agentSpawn"]>["agents"],
): WorkLogToolLifecycleStatus {
  const statuses = agents.map((agent) => agent.status);
  if (statuses.some((status) => status === undefined || status === "inProgress")) {
    return "inProgress";
  }
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("declined")) return "declined";
  if (statuses.includes("stopped")) return "stopped";
  return "completed";
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  // Task rows collapse by identity, not adjacency (quiet-timeline guarantee;
  // mirrors web's session-logic). Background tasks keep one row per taskId;
  // agent spawns fold into one row per spawn group, decided at the FIRST row
  // seen for a taskId because later rows can arrive under synthetic turns.
  const taskRowIndex = new Map<string, number>();
  const spawnRowIndex = new Map<string, number>();
  const spawnGroupByTaskId = new Map<string, string>();
  const toolLifecycleRowIndex = new Map<string, number>();
  // Tool calls that launched an agent (Claude's Agent tool, ACP subagent
  // calls). The batch card is the whole story of that call, so its own
  // lifecycle row is dropped.
  const spawnToolCallIds = new Set(
    entries.flatMap((entry) =>
      entry.agentSpawnToolCallId !== undefined ? [entry.agentSpawnToolCallId] : [],
    ),
  );
  for (const entry of entries) {
    if (
      entry.toolCallId !== undefined &&
      entry.taskId === undefined &&
      spawnToolCallIds.has(entry.toolCallId)
    ) {
      continue;
    }
    const isTaskRow =
      entry.taskId !== undefined &&
      (entry.sourceActivityKind === "task.started" ||
        entry.sourceActivityKind === "task.progress" ||
        entry.sourceActivityKind === "task.completed" ||
        entry.sourceActivityKind === "task.updated");
    if (isTaskRow && entry.taskId !== undefined) {
      if (entry.isBackgroundTask) {
        const existingIndex = taskRowIndex.get(entry.taskId);
        if (existingIndex !== undefined) {
          collapsed[existingIndex] = mergeDerivedWorkLogEntries(collapsed[existingIndex]!, entry);
          continue;
        }
        taskRowIndex.set(entry.taskId, collapsed.length);
        collapsed.push(entry);
        continue;
      }
      const groupKey = spawnGroupByTaskId.get(entry.taskId) ?? agentSpawnGroupKey(entry);
      spawnGroupByTaskId.set(entry.taskId, groupKey);
      const existingIndex = spawnRowIndex.get(groupKey);
      if (existingIndex !== undefined) {
        collapsed[existingIndex] = mergeAgentSpawnEntries(collapsed[existingIndex]!, entry);
        continue;
      }
      spawnRowIndex.set(groupKey, collapsed.length);
      collapsed.push(
        agentSpawnRow(
          entry,
          groupKey.startsWith("wf:") ? groupKey.slice(3) : null,
          [entry.taskId],
          [agentSpawnMember(entry)],
        ),
      );
      continue;
    }
    const lifecycleKey = toolLifecycleCollapseMapKey(entry);
    if (lifecycleKey !== undefined) {
      const matchingIndex = toolLifecycleRowIndex.get(lifecycleKey);
      const matchingEntry = matchingIndex === undefined ? undefined : collapsed[matchingIndex];
      if (
        matchingIndex !== undefined &&
        matchingEntry &&
        shouldCollapseToolLifecycleEntries(matchingEntry, entry)
      ) {
        collapsed[matchingIndex] = mergeDerivedWorkLogEntries(matchingEntry, entry);
        continue;
      }
      toolLifecycleRowIndex.delete(lifecycleKey);
    }
    const previous = collapsed.at(-1);
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      const previousIndex = collapsed.length - 1;
      const previousKey = toolLifecycleCollapseMapKey(previous);
      if (previousKey !== undefined) toolLifecycleRowIndex.delete(previousKey);
      const merged = mergeDerivedWorkLogEntries(previous, entry);
      collapsed[previousIndex] = merged;
      const mergedKey = toolLifecycleCollapseMapKey(merged);
      if (mergedKey !== undefined) toolLifecycleRowIndex.set(mergedKey, previousIndex);
      continue;
    }
    collapsed.push(entry);
    if (lifecycleKey !== undefined) {
      toolLifecycleRowIndex.set(lifecycleKey, collapsed.length - 1);
    }
  }
  return collapsed;
}

function toolLifecycleCollapseMapKey(entry: DerivedWorkLogEntry): string | undefined {
  if (
    entry.sourceActivityKind !== "tool.updated" &&
    entry.sourceActivityKind !== "tool.completed"
  ) {
    return undefined;
  }
  return entry.toolCallId ? `tool:${entry.turnId ?? "no-turn"}:${entry.toolCallId}` : undefined;
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (
    previous.sourceActivityKind !== "tool.updated" &&
    previous.sourceActivityKind !== "tool.completed"
  ) {
    return false;
  }
  if (next.sourceActivityKind !== "tool.updated" && next.sourceActivityKind !== "tool.completed") {
    return false;
  }
  if (previous.turnId !== next.turnId) {
    return false;
  }
  if (previous.sourceActivityKind === "tool.completed") {
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
  const viewedImagePath = next.viewedImagePath ?? previous.viewedImagePath;
  const command = next.command ?? previous.command;
  const rawCommand = next.rawCommand ?? previous.rawCommand;
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const toolSurface = next.toolSurface ?? previous.toolSurface;
  const toolIcon = next.toolIcon ?? previous.toolIcon;
  const toolSource = next.toolSource ?? previous.toolSource;
  const itemType = next.itemType ?? previous.itemType;
  const requestKind = next.requestKind ?? previous.requestKind;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const toolLifecycleStatus = next.toolLifecycleStatus ?? previous.toolLifecycleStatus;
  const toolCallId = next.toolCallId ?? previous.toolCallId;
  const toolData = next.toolData ?? previous.toolData;
  return {
    ...previous,
    ...next,
    id: previous.id,
    createdAt: previous.createdAt,
    ...(detail ? { detail } : {}),
    ...(viewedImagePath ? { viewedImagePath } : {}),
    ...(command ? { command } : {}),
    ...(rawCommand ? { rawCommand } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(toolSurface ? { toolSurface } : {}),
    ...(toolIcon ? { toolIcon } : {}),
    ...(toolSource ? { toolSource } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(toolLifecycleStatus ? { toolLifecycleStatus } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolData !== undefined ? { toolData } : {}),
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
    entry.sourceActivityKind !== "tool.updated" &&
    entry.sourceActivityKind !== "tool.completed"
  ) {
    return undefined;
  }
  if (entry.toolCallId) {
    return `tool:${entry.turnId ?? "no-turn"}:${entry.toolCallId}`;
  }
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const detail = entry.detail?.trim() ?? "";
  const itemType = entry.itemType ?? "";
  if (normalizedLabel.length === 0 && detail.length === 0 && itemType.length === 0) {
    return undefined;
  }
  return [itemType, normalizedLabel, detail].join("\u001f");
}

function workLogEntryIsToolLike(entry: WorkLogEntry): boolean {
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

function toolDetailTextLooksLikeFailure(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("file not found") ||
    normalized.includes("no files found") ||
    normalized.includes("enoent") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("no such file") ||
    normalized.includes("commandnotfoundexception") ||
    normalized.includes("command not found") ||
    (normalized.includes("cannot find path") && normalized.includes("because it does not exist")) ||
    (normalized.includes("is not recognized") && normalized.includes("the term '")) ||
    normalized.includes("is not recognized as the name of a cmdlet") ||
    normalized.includes("a parameter cannot be found that matches parameter name") ||
    /<exited with exit code\s+[1-9]\d*\s*>/i.test(text) ||
    /exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text) ||
    /exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)
  );
}

function workEntryIndicatesToolFailure(entry: WorkLogEntry): boolean {
  if (entry.tone === "error") {
    return true;
  }
  if (entry.toolLifecycleStatus === "failed" || entry.toolLifecycleStatus === "declined") {
    return true;
  }
  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }
  return toolDetailTextLooksLikeFailure([entry.detail, entry.command].filter(Boolean).join("\n"));
}

function workEntryIndicatesToolSuccess(entry: WorkLogEntry): boolean {
  if (!workLogEntryIsToolLike(entry) || workEntryIndicatesToolFailure(entry)) {
    return false;
  }
  if (entry.tone === "thinking") {
    return false;
  }
  return (
    entry.toolLifecycleStatus !== "inProgress" &&
    entry.toolLifecycleStatus !== "stopped" &&
    entry.toolLifecycleStatus !== "failed" &&
    entry.toolLifecycleStatus !== "declined"
  );
}

function workEntryStatus(entry: WorkLogEntry): ThreadFeedActivity["status"] {
  if (entry.agentSpawn) {
    switch (entry.toolLifecycleStatus) {
      case "failed":
        return "failure";
      case "completed":
        return "success";
      default:
        return "neutral";
    }
  }
  if (!workLogEntryIsToolLike(entry)) {
    return null;
  }
  if (workEntryIndicatesToolFailure(entry)) {
    return "failure";
  }
  if (workEntryIndicatesToolSuccess(entry)) {
    return "success";
  }
  return "neutral";
}

function workEntryIcon(entry: DerivedWorkLogEntry): ThreadFeedActivity["icon"] {
  if (entry.agentSpawn) return "agent";
  if (
    entry.sourceActivityKind === "user-input.requested" ||
    entry.sourceActivityKind === "user-input.resolved"
  ) {
    return "message";
  }
  if (entry.sourceActivityKind === "runtime.warning") return "warning";
  if (entry.toolSurface) return entry.toolSurface;
  if (entry.requestKind === "command") return "command";
  if (entry.requestKind === "file-read") return "eye";
  if (entry.requestKind === "file-change") return "edit";
  if (entry.itemType === "command_execution" || entry.command) return "command";
  if (entry.itemType === "file_change" || (entry.changedFiles?.length ?? 0) > 0) return "edit";
  if (entry.itemType === "web_search") return "globe";
  if (entry.itemType === "image_view") return "eye";
  if (entry.itemType === "mcp_tool_call") return "wrench";
  if (entry.itemType === "dynamic_tool_call" || entry.itemType === "collab_agent_tool_call") {
    return "hammer";
  }
  if (entry.tone === "error") return "alert";
  if (entry.tone === "thinking") return "agent";
  if (entry.tone === "info") return "check";
  return "zap";
}

function buildWorkEntryExpandedBody(entry: WorkLogEntry): string | null {
  if (entry.agentSpawn) return agentSpawnExpandedBody(entry.agentSpawn);
  const blocks: string[] = [];
  const appendBlock = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && (entry.command || !blocks.includes(trimmed))) blocks.push(trimmed);
  };

  if (entry.itemType === "mcp_tool_call" && entry.toolData !== undefined) {
    appendBlock(`MCP call\n${JSON.stringify(entry.toolData, null, 2)}`);
  }
  appendBlock(entry.rawCommand ?? entry.command);
  appendBlock(entry.detail);
  if ((entry.changedFiles?.length ?? 0) > 0) {
    appendBlock(entry.changedFiles!.join("\n"));
  }

  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

/**
 * A row only opens when its body says more than its collapsed line. A row
 * whose only detail is the single-line text it already shows (a runtime
 * warning, a task summary, a short command) has nothing to reveal.
 * Multi-line text still expands: the collapsed row truncates it to one line.
 * Cheap field checks come first so large tool payloads are not serialized
 * for every row (see the deferred-expansion test).
 */
function workEntryHasExpandedBody(entry: WorkLogEntry, collapsedText: string): boolean {
  if (entry.agentSpawn) return agentSpawnMembers(entry.agentSpawn).length > 0;
  if (entry.itemType === "mcp_tool_call" && entry.toolData !== undefined) return true;
  if (entry.changedFiles?.some((path) => path.trim().length > 0)) return true;
  const parts = [entry.rawCommand ?? entry.command, entry.detail]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (parts.length === 0) return false;
  if (parts.length > 1 && new Set(parts).size > 1) return true;
  const only = parts[0]!;
  return only.includes("\n") || collapseWhitespace(only) !== collapseWhitespace(collapsedText);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripShellWrapper(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^\/bin\/zsh -lc ['"]?([\s\S]*?)['"]?$/);
  return (match?.[1] ?? trimmed).trim();
}

/** The one-line text a collapsed work row shows. */
export function workEntryRowLabel(entry: WorkLogEntry): string {
  if (entry.agentSpawn) return agentSpawnLabel(entry.agentSpawn);
  const presentation = resolveWorkEntryToolPresentation(entry);
  if (presentation) return presentation.displayName;
  const preview = workEntryPreview(entry);
  const compactPreview = preview === null ? null : collapseWhitespace(stripShellWrapper(preview));
  return compactPreview || workEntryHeading(entry);
}

function memoizeValue<T>(build: () => T): () => T {
  let value: T;
  let initialized = false;
  return () => {
    if (!initialized) {
      value = build();
      initialized = true;
    }
    return value;
  };
}

function workEntryPreview(
  workEntry: Pick<WorkLogEntry, "detail" | "command" | "changedFiles">,
): string | null {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  return workEntry.changedFiles!.length === 1
    ? firstPath
    : `${firstPath} +${workEntry.changedFiles!.length - 1} more`;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

/**
 * Batch label for a spawn row, matching web's CTA wording. Web reads live
 * agent state from its Agents panel; mobile has only the lifecycle states
 * folded into the row, so "working" means a member has not reported a
 * terminal state yet.
 */
export function agentSpawnLabel(spawn: NonNullable<WorkLogEntry["agentSpawn"]>): string {
  const members = agentSpawnMembers(spawn);
  const count = Math.max(members.length, 1);
  const subjects = `${count} subagent${count === 1 ? "" : "s"}`;
  const working = members.filter(
    (agent) => agent.status === undefined || agent.status === "inProgress",
  ).length;
  const failed = members.filter((agent) => agent.status === "failed").length;
  const stopped = members.filter((agent) => agent.status === "stopped").length;
  if (working > 0) {
    return `Kicked off ${subjects} · ${working} working`;
  }
  const status = failed > 0 ? `${failed} failed` : stopped > 0 ? `${stopped} stopped` : "completed";
  return `Ran ${subjects} · ${status}`;
}

/** Workflow coordinators sit in their own batch but are not a member. */
function agentSpawnMembers(spawn: NonNullable<WorkLogEntry["agentSpawn"]>) {
  return spawn.agents.filter((_, index) => spawn.agentTaskIds[index] !== spawn.workflowId);
}

function agentSpawnTone(status: WorkLogToolLifecycleStatus | undefined): AgentSpawnSummary["tone"] {
  switch (status) {
    case undefined:
    case "inProgress":
      return "working";
    case "completed":
      return "completed";
    case "failed":
    case "declined":
      return "failed";
    case "stopped":
      return "stopped";
  }
}

/**
 * What the spawn card shows. While members work, the status line is the
 * newest member activity (its progress detail), so the card reads like the
 * live tool row does for a single call. Once every member settles, it is the
 * batch outcome in web's CTA wording.
 */
export function agentSpawnSummary(
  spawn: NonNullable<WorkLogEntry["agentSpawn"]>,
  batchStatus: WorkLogToolLifecycleStatus | undefined,
): AgentSpawnSummary {
  const members = agentSpawnMembers(spawn).map((agent) => {
    const tone = agentSpawnTone(agent.status);
    return {
      title: agent.title,
      status: tone === "working" ? "working" : (agent.status ?? tone),
      tone,
      detail: agent.detail,
      updatedAt: agent.updatedAt,
    };
  });
  const tone = agentSpawnTone(batchStatus);
  // A workflow's coordinator is not a member; before any member reports the
  // batch has none.
  const title =
    members.length === 0
      ? "Subagents"
      : members.length === 1
        ? members[0]!.title
        : `${members.length} subagents`;
  if (tone === "working") {
    const working = members.filter((member) => member.tone === "working");
    const latest = working
      .filter((member) => member.detail !== undefined)
      .reduce<(typeof working)[number] | undefined>(
        (newest, member) =>
          newest === undefined || member.updatedAt > newest.updatedAt ? member : newest,
        undefined,
      );
    const status =
      latest?.detail ??
      (members.length > 1 ? `${working.length} of ${members.length} working` : "Working");
    return { title, status, tone, members };
  }
  // The batch tone covers a coordinator that failed or stopped on its own.
  const failed = members.filter((member) => member.tone === "failed").length;
  const stopped = members.filter((member) => member.tone === "stopped").length;
  const outcome =
    tone === "failed" || failed > 0
      ? `${members.length > 1 && failed > 0 ? `${failed} ` : ""}failed`
      : tone === "stopped" || stopped > 0
        ? `${members.length > 1 && stopped > 0 ? `${stopped} ` : ""}stopped`
        : "completed";
  return { title, status: outcome, tone, members };
}

function agentSpawnExpandedBody(spawn: NonNullable<WorkLogEntry["agentSpawn"]>): string | null {
  const lines = agentSpawnMembers(spawn).map((agent) => {
    const status =
      agent.status === undefined || agent.status === "inProgress" ? "working" : agent.status;
    return `${agent.title} · ${status}${agent.detail ? `\n  ${agent.detail}` : ""}`;
  });
  return lines.length > 0 ? lines.join("\n") : null;
}

function workEntryHeading(workEntry: WorkLogEntry): string {
  if (workEntry.agentSpawn) return agentSpawnLabel(workEntry.agentSpawn);
  const presentation = resolveWorkEntryToolPresentation(workEntry);
  if (presentation) return presentation.displayName;
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

function singleToolCallLabel(activity: ThreadFeedActivity): string {
  const presentation = resolveWorkEntryToolPresentation(activity.workEntry, "completed");
  if (presentation) return presentation.displayName;
  const command = activity.workEntry.command?.trim();
  return command || activity.summary;
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

  const openingQuote = command[0];
  if ((openingQuote === "'" || openingQuote === '"') && !command.endsWith(openingQuote)) {
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

function extractWorkLogToolLifecycleStatus(
  payload: Record<string, unknown> | null,
): WorkLogToolLifecycleStatus | undefined {
  const status = payload?.status;
  // The parent turn ended, so batch tracking is inactive. The detail explains
  // that child status is unavailable; do not retain the earlier running marker.
  if (status === "idle" && payload?.taskType === "subagent_batch") return "stopped";
  if (status === "pending" || status === "running" || status === "waiting") return "inProgress";
  if (status === "cancelled" || status === "interrupted") return "stopped";
  if (
    status === "inProgress" ||
    status === "completed" ||
    status === "failed" ||
    status === "declined" ||
    status === "stopped"
  ) {
    return status;
  }
  return undefined;
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

const activityOrder = Order.combineAll<OrchestrationThreadActivity>([
  Order.mapInput(Order.Number, (activity) => activity.sequence ?? Number.MAX_SAFE_INTEGER),
  Order.mapInput(Order.String, (activity) => activity.createdAt),
  Order.mapInput(Order.Number, (activity) => compareActivityLifecycleRank(activity.kind)),
  Order.mapInput(Order.String, (activity) => activity.id),
]);

function isEmptyMessage(entry: RawThreadFeedEntry): boolean {
  if (entry.type !== "message") {
    return false;
  }
  const hasText = entry.message.text.trim().length > 0;
  const hasAttachments = (entry.message.attachments ?? []).length > 0;
  return !hasText && !hasAttachments;
}

function groupAdjacentActivities(entries: ReadonlyArray<RawThreadFeedEntry>): ThreadFeedEntry[] {
  const grouped: ThreadFeedEntry[] = [];
  let firstActivityEntry: Extract<RawThreadFeedEntry, { readonly type: "activity" }> | null = null;
  let openGroupActivities: ThreadFeedActivity[] = [];
  const flushGroup = () => {
    if (firstActivityEntry === null) return;
    const cached = activityGroupsCache.get(firstActivityEntry.activity);
    if (
      cached &&
      cached.activities.length === openGroupActivities.length &&
      cached.activities.every((activity, index) => activity === openGroupActivities[index])
    ) {
      grouped.push(cached);
    } else {
      const group: ThreadFeedActivityGroup = {
        type: "activity-group",
        id: firstActivityEntry.id,
        createdAt: firstActivityEntry.createdAt,
        turnId: firstActivityEntry.turnId,
        activities: openGroupActivities,
      };
      activityGroupsCache.set(firstActivityEntry.activity, group);
      grouped.push(group);
    }
    firstActivityEntry = null;
    openGroupActivities = [];
  };

  for (const entry of entries) {
    // Skip empty messages so they don't break activity grouping.
    if (isEmptyMessage(entry)) {
      continue;
    }

    if (entry.type !== "activity") {
      flushGroup();
      grouped.push(entry);
      continue;
    }

    const isCompaction = entry.activity.workEntry.sourceActivityKind === "context-compaction";
    if (isCompaction || firstActivityEntry?.turnId !== entry.turnId) {
      flushGroup();
    }
    firstActivityEntry ??= entry;
    openGroupActivities.push(entry.activity);
    if (isCompaction) {
      flushGroup();
    }
  }
  flushGroup();
  return grouped;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

function deriveUnsettledTurnId(latestTurn: ThreadFeedLatestTurn | null): TurnId | null {
  if (!latestTurn) {
    return null;
  }
  const settled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return settled ? null : latestTurn.turnId;
}

interface ThreadFeedTurnFold {
  readonly turnId: TurnId;
  readonly createdAt: string;
  readonly hiddenEntryIds: ReadonlySet<string>;
  readonly label: string;
}

function deriveThreadFeedTurnFolds(
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestTurn: ThreadFeedLatestTurn | null,
): ReadonlyMap<string, ThreadFeedTurnFold> {
  const firstAssistantMessageIdByTurn = new Map<TurnId, string>();
  const terminalAssistantMessageIdByTurn = new Map<TurnId, string>();
  for (const entry of feed) {
    if (entry.type === "message" && entry.message.role === "assistant" && entry.message.turnId) {
      if (!firstAssistantMessageIdByTurn.has(entry.message.turnId)) {
        firstAssistantMessageIdByTurn.set(entry.message.turnId, entry.id);
      }
      terminalAssistantMessageIdByTurn.set(entry.message.turnId, entry.id);
    }
  }

  interface TurnGroup {
    readonly entries: ThreadFeedEntry[];
    readonly startBoundary: string | null;
  }
  const groupsByTurnId = new Map<TurnId, TurnGroup>();
  let pendingUserBoundary: string | null = null;
  for (const entry of feed) {
    if (entry.type === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }
    const turnId =
      entry.type === "message" && entry.message.role === "assistant"
        ? entry.message.turnId
        : entry.type === "activity-group"
          ? entry.turnId
          : null;
    if (!turnId) {
      continue;
    }
    let group = groupsByTurnId.get(turnId);
    if (!group) {
      group = {
        entries: [],
        startBoundary: pendingUserBoundary,
      };
      pendingUserBoundary = null;
      groupsByTurnId.set(turnId, group);
    }
    group.entries.push(entry);
  }

  const unsettledTurnId = deriveUnsettledTurnId(latestTurn);
  const foldsByAnchorId = new Map<string, ThreadFeedTurnFold>();
  for (const [turnId, group] of groupsByTurnId) {
    const { entries } = group;
    if (turnId === unsettledTurnId) {
      continue;
    }
    if (entries.some((entry) => entry.type === "message" && entry.message.streaming)) {
      continue;
    }

    const firstAssistantMessageId = firstAssistantMessageIdByTurn.get(turnId);
    const terminalAssistantMessageId = terminalAssistantMessageIdByTurn.get(turnId);
    const hiddenEntryIds = new Set(
      entries
        .filter(
          (entry) =>
            entry.id !== firstAssistantMessageId && entry.id !== terminalAssistantMessageId,
        )
        .map((entry) => entry.id),
    );
    if (hiddenEntryIds.size === 0) {
      continue;
    }
    // A lone compaction row stays visible on its own; it only folds away as
    // part of a turn that already folds other work.
    const hidesNonCompactionWork = entries.some(
      (entry) =>
        hiddenEntryIds.has(entry.id) &&
        !(entry.type === "activity-group" && isContextCompactionActivityGroup(entry)),
    );
    if (!hidesNonCompactionWork) {
      continue;
    }

    const firstEntry = entries[0];
    const firstHiddenEntry = entries.find((entry) => hiddenEntryIds.has(entry.id));
    const lastEntry = entries.at(-1);
    if (!firstEntry || !firstHiddenEntry || !lastEntry) {
      continue;
    }
    const terminalEntry = terminalAssistantMessageId
      ? entries.find((entry) => entry.id === terminalAssistantMessageId)
      : null;
    const latestTurnMatches = latestTurn?.turnId === turnId;
    const lastEntryEnd =
      lastEntry.type === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const elapsedMs =
      latestTurnMatches && latestTurn.startedAt && latestTurn.completedAt
        ? computeElapsedMs(latestTurn.startedAt, latestTurn.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(
              terminalEntry?.type === "message" ? terminalEntry.message.updatedAt : null,
              lastEntryEnd,
            ) ?? lastEntryEnd,
          );
    const duration = elapsedMs === null ? null : formatDuration(elapsedMs);
    const interrupted = latestTurnMatches && latestTurn.state === "interrupted";
    const label = interrupted
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    foldsByAnchorId.set(firstHiddenEntry.id, {
      turnId,
      createdAt: firstHiddenEntry.createdAt,
      hiddenEntryIds,
      label,
    });
  }
  return foldsByAnchorId;
}

export function deriveThreadFeedPresentation(
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestTurn: ThreadFeedLatestTurn | null,
  expandedTurnIds: ReadonlySet<TurnId>,
  expandedWorkGroupIds: ReadonlySet<string> = new Set(),
  activeWorkStartedAt: string | null = null,
): ThreadFeedEntry[] {
  const sourceFeed = feed.filter(
    (entry) =>
      entry.type !== "turn-fold" &&
      entry.type !== "work-toggle" &&
      entry.type !== "thinking" &&
      entry.type !== "agent-spawn",
  );
  const activeTailGroup = sourceFeed.findLast(
    (entry) => entry.type !== "message" || !isEmptyMessage(entry),
  );
  const foldsByAnchorId = deriveThreadFeedTurnFolds(sourceFeed, latestTurn);
  const unsettledTurnId = deriveUnsettledTurnId(latestTurn);
  const isWorking = activeWorkStartedAt !== null;
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorId.values()) {
    if (!expandedTurnIds.has(fold.turnId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
  }

  const result: ThreadFeedEntry[] = [];
  for (const entry of sourceFeed) {
    const isActiveTailGroup =
      isWorking &&
      unsettledTurnId !== null &&
      entry.type === "activity-group" &&
      activeTailGroup?.type === "activity-group" &&
      activeTailGroup.id === entry.id &&
      entry.turnId === unsettledTurnId;
    const fold = foldsByAnchorId.get(entry.id);
    if (fold) {
      const expanded = expandedTurnIds.has(fold.turnId);
      let row = turnFoldRowsCache.get(entry);
      if (
        !row ||
        row.turnId !== fold.turnId ||
        row.createdAt !== fold.createdAt ||
        row.label !== fold.label ||
        row.expanded !== expanded
      ) {
        row = {
          type: "turn-fold",
          id: `turn-fold:${fold.turnId}`,
          createdAt: fold.createdAt,
          turnId: fold.turnId,
          label: fold.label,
          expanded,
        };
        turnFoldRowsCache.set(entry, row);
      }
      result.push(row);
    }
    if (!collapsedEntryIds.has(entry.id)) {
      appendPresentedFeedEntry(
        result,
        entry,
        expandedWorkGroupIds,
        unsettledTurnId,
        isWorking,
        isActiveTailGroup,
      );
    }
  }
  // A working turn always shows one live activity. When no tool row is
  // shimmering (no tools yet, or the latest failed), that row is "Thinking".
  // The trailing group's live row and this row share LIVE_ACTIVITY_ROW_ID, so
  // the handoff between them happens in place (one row, new content) instead
  // of a row being inserted below the group every time a call fails.
  if (
    activeWorkStartedAt !== null &&
    !result.some(
      (row) =>
        (row.type === "work-toggle" && row.shimmer) ||
        // A working spawn card is the live activity: its status line shows
        // what the agents are doing, so a Thinking row under it would lie.
        (row.type === "agent-spawn" &&
          row.summary.tone === "working" &&
          row.turnId === unsettledTurnId),
    )
  ) {
    result.push(thinkingRow(activeWorkStartedAt, unsettledTurnId));
  }
  return result;
}

/**
 * Shared by the trailing tool group's live row and the "Thinking" row so the
 * list keeps one mounted row for the turn's live slot (mirrors web's
 * LIVE_ACTIVITY_ROW_ID). Anything keyed by row id must not distinguish them.
 */
export const LIVE_ACTIVITY_ROW_ID = "live-activity-row";

function thinkingRow(createdAt: string, turnId: TurnId | null) {
  if (cachedThinkingRow?.createdAt !== createdAt || cachedThinkingRow.turnId !== turnId) {
    cachedThinkingRow = { type: "thinking", id: LIVE_ACTIVITY_ROW_ID, createdAt, turnId };
  }
  return cachedThinkingRow;
}

function appendPresentedFeedEntry(
  result: ThreadFeedEntry[],
  entry: Exclude<ThreadFeedEntry, { readonly type: "turn-fold" | "work-toggle" | "thinking" }>,
  expandedWorkGroupIds: ReadonlySet<string>,
  unsettledTurnId: TurnId | null,
  isWorking: boolean,
  activeTail: boolean,
): void {
  if (entry.type !== "activity-group") {
    result.push(entry);
    return;
  }
  if (isContextCompactionActivityGroup(entry)) {
    result.push(entry);
    return;
  }

  let cached = presentedActivityGroupsCache.get(entry);
  if (
    !cached ||
    cached.unsettledTurnId !== unsettledTurnId ||
    cached.isWorking !== isWorking ||
    cached.activeTail !== activeTail ||
    cached.rows.some(
      (row) =>
        (row.type === "work-toggle" && expandedWorkGroupIds.has(row.groupId) !== row.expanded) ||
        (row.type === "agent-spawn" && expandedWorkGroupIds.has(row.id) !== row.expanded),
    )
  ) {
    const rows: ThreadFeedEntry[] = [];
    appendActivityGroupRows(
      rows,
      entry,
      expandedWorkGroupIds,
      unsettledTurnId,
      isWorking,
      activeTail,
    );
    cached = { unsettledTurnId, isWorking, activeTail, rows };
    presentedActivityGroupsCache.set(entry, cached);
  }
  for (const row of cached.rows) {
    result.push(row);
  }
}

function appendActivityGroupRows(
  result: ThreadFeedEntry[],
  entry: ThreadFeedActivityGroup,
  expandedWorkGroupIds: ReadonlySet<string>,
  unsettledTurnId: TurnId | null,
  isWorking: boolean,
  activeTail: boolean,
): void {
  const activities = omitSupersededLifecycleMarkers(
    entry.activities.filter(
      (activity) =>
        !(activity.toolLike && activity.status === "neutral") ||
        (isWorking &&
          activity.lifecycleStatus === "inProgress" &&
          activity.turnId === unsettledTurnId),
    ),
    (activity) => activity.workEntry,
  );
  if (activities.length === 0) {
    return;
  }
  let groupableRun: ThreadFeedActivity[] = [];
  const flushGroupableRun = (isTrailingRun: boolean) => {
    if (groupableRun.length === 0) return;
    appendToolGroupRows(
      result,
      entry,
      groupableRun,
      expandedWorkGroupIds,
      unsettledTurnId,
      isWorking,
      activeTail && isTrailingRun,
    );
    groupableRun = [];
  };
  for (const activity of activities) {
    const spawn = activity.workEntry.agentSpawn;
    if (activity.workEntry.tone !== "error" && spawn === undefined) {
      groupableRun.push(activity);
      continue;
    }
    flushGroupableRun(false);
    if (spawn !== undefined) {
      // Keyed by the batch, not the anchor activity: the anchor can change
      // as members arrive, and a changed key remounts the card.
      const groupId = `agent-spawn:${spawn.workflowId ?? activity.turnId ?? spawn.agentTaskIds[0]}`;
      result.push({
        type: "agent-spawn",
        id: groupId,
        createdAt: activity.createdAt,
        turnId: activity.turnId,
        activity,
        expanded: expandedWorkGroupIds.has(groupId),
        summary: agentSpawnSummary(spawn, activity.lifecycleStatus),
      });
      continue;
    }
    result.push({
      type: "activity-group",
      id: activity.id,
      createdAt: activity.createdAt,
      turnId: activity.turnId,
      activities: [activity],
    });
  }
  flushGroupableRun(true);
}

function appendToolGroupRows(
  result: ThreadFeedEntry[],
  sourceGroup: Extract<ThreadFeedEntry, { readonly type: "activity-group" }>,
  activities: ReadonlyArray<ThreadFeedActivity>,
  expandedWorkGroupIds: ReadonlySet<string>,
  unsettledTurnId: TurnId | null,
  isWorking: boolean,
  activeTail: boolean,
): void {
  const firstEntry = activities[0]!.workEntry;
  const identity = firstEntry.toolCallId
    ? `tool:${firstEntry.turnId ?? "no-turn"}:${firstEntry.toolCallId}`
    : activities[0]!.id;
  const groupId = `work-group:${identity}`;
  const expanded = expandedWorkGroupIds.has(groupId);
  const latestActiveActivity = activities.findLast(
    (activity) =>
      isWorking &&
      activity.turnId === unsettledTurnId &&
      (activity.lifecycleStatus === "inProgress" ||
        (activeTail &&
          activity.lifecycleStatus === undefined &&
          (activity.workEntry.sourceActivityKind === "task.progress" || activity.toolLike))),
  );
  const active = latestActiveActivity !== undefined;
  const live = activeTail || active;
  const latestActivity = latestActiveActivity ?? activities.at(-1)!;
  // Like web, the trailing run keeps shining after its latest call succeeds;
  // only a failed, declined, or stopped call hands the live slot to "Thinking".
  // Only the trailing run can be the turn's live slot; an in-progress row in
  // an earlier run (a call whose end was never reported) stays in place.
  const shimmer = activeTail && (active || latestActivity.status === "success");
  const singleActivity = activities.length === 1 ? latestActivity : null;
  const summary = live
    ? liveToolActivitySummary(latestActivity, live)
    : singleActivity !== null &&
        singleActivity.toolLike &&
        toolGroupAction(singleActivity.workEntry) !== "edit"
      ? singleToolCallLabel(singleActivity)
      : singleActivity !== null && !singleActivity.toolLike
        ? singleActivity.workEntry.label
        : summarizeToolGroup(activities.map((activity) => activity.workEntry));
  const primarySourceActivity = activities.find(
    (activity) => activity.workEntry.toolSource !== undefined,
  );
  const primarySourceKey = primarySourceActivity?.workEntry.toolSource?.key;
  const primarySourceIcon = primarySourceKey
    ? (activities.find(
        (activity) =>
          activity.workEntry.toolSource?.key === primarySourceKey &&
          activity.workEntry.toolIcon !== undefined,
      )?.workEntry.toolIcon ?? primarySourceActivity?.workEntry.toolSource?.icon)
    : undefined;
  const groupToolSurface =
    primarySourceActivity?.workEntry.toolSurface ??
    latestActivity.workEntry.toolSurface ??
    activities.findLast((activity) => activity.workEntry.toolSurface !== undefined)?.workEntry
      .toolSurface;
  const groupToolIcon =
    primarySourceIcon ??
    latestActivity.workEntry.toolIcon ??
    activities.findLast((activity) => activity.workEntry.toolIcon !== undefined)?.workEntry
      .toolIcon;
  const summaryToolIcon = live
    ? resolveWorkEntryToolPresentation(latestActivity.workEntry)?.icon
    : singleActivity !== null &&
        singleActivity.toolLike &&
        toolGroupAction(singleActivity.workEntry) !== "edit"
      ? resolveWorkEntryToolPresentation(singleActivity.workEntry, "completed")?.icon
      : undefined;
  result.push({
    type: "work-toggle",
    // The shimmering trailing row is the turn's live slot; it keeps that
    // identity (and so its mounted view) until "Thinking" takes the slot.
    id: shimmer ? LIVE_ACTIVITY_ROW_ID : `${live ? "work-live" : "work-toggle"}:${groupId}`,
    createdAt: sourceGroup.createdAt,
    turnId: sourceGroup.turnId,
    groupId,
    hiddenCount: activities.length,
    expanded,
    summary,
    summaryKind: toolGroupSummaryKind(
      (live ? [latestActivity] : activities).map((activity) => activity.workEntry),
    ),
    ...(groupToolSurface ? { toolSurface: groupToolSurface } : {}),
    ...(groupToolIcon ? { toolIcon: groupToolIcon } : {}),
    ...(summaryToolIcon ? { summaryToolIcon } : {}),
    hasFailure: activities.findLast((activity) => activity.toolLike)?.status === "failure",
    live,
    shimmer,
  });
  if (!expanded) {
    return;
  }
  result.push({
    type: "activity-group",
    id: `work-details:${groupId}`,
    createdAt: activities[0]!.createdAt,
    turnId: activities[0]!.turnId,
    activities: activities.map((activity) => ({
      ...activity,
      groupedToolDetail: true,
      live:
        isWorking &&
        activity.id === latestActivity.id &&
        activity.lifecycleStatus === "inProgress" &&
        activity.turnId === unsettledTurnId,
    })),
  });
}

function liveToolActivitySummary(activity: ThreadFeedActivity, presentTense: boolean): string {
  const status = liveActivityToolStatus(activity.lifecycleStatus, presentTense);
  const presentation = resolveWorkEntryToolPresentation({
    ...activity.workEntry,
    toolLifecycleStatus: status,
  });
  if (presentation) return presentation.displayName;
  const command = activity.workEntry.command?.trim();
  if (command) {
    const program = commandProgramName(command);
    const verb =
      status === "inProgress"
        ? "Running"
        : status === "failed"
          ? "Failed"
          : status === "declined"
            ? "Declined"
            : status === "stopped"
              ? "Stopped"
              : "Ran";
    return `${verb} ${program ?? "command"}`;
  }
  return activity.detail ?? activity.summary;
}

/**
 * Sorts activities into lifecycle order. `derivePendingApprovals` and
 * `derivePendingUserInputs` both expect this ordering; sorting once and
 * passing the result to both avoids re-sorting the full activity history
 * per derivation.
 */
export function sortThreadActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  return Arr.sort(activities, activityOrder);
}

export function derivePendingApprovals(
  sortedActivities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();

  for (const activity of sortedActivities) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = parseApprovalRequestId(payload?.requestId);
    const requestKind = isProviderRequestKind(payload?.requestKind)
      ? payload.requestKind
      : requestKindFromRequestType(payload?.requestType);
    const detail = typeof payload?.detail === "string" ? payload.detail : undefined;
    const appName = typeof payload?.appName === "string" ? payload.appName : undefined;
    const options = Array.isArray(payload?.options)
      ? payload.options.filter(isProviderApprovalOption)
      : undefined;

    if (
      activity.kind === "approval.requested" &&
      requestId &&
      payload?.requestType !== "tool_user_input" &&
      payload?.requestType !== "auth_tokens_refresh"
    ) {
      openByRequestId.set(requestId, {
        requestId,
        // Older OpenCode requests can have no recognized approval kind.
        requestKind: requestKind ?? "command",
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
        ...(appName ? { appName } : {}),
        ...(options && options.length > 0 ? { options } : {}),
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
    }
  }

  return Arr.sortWith([...openByRequestId.values()], (s) => new Date(s.createdAt), Order.Date);
}

export function derivePendingUserInputs(
  sortedActivities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();

  for (const activity of sortedActivities) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = parseApprovalRequestId(payload?.requestId);
    const detail = typeof payload?.detail === "string" ? payload.detail : undefined;

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

  return Arr.sortWith(openByRequestId.values(), (s) => new Date(s.createdAt), Order.Date);
}

export function setPendingUserInputCustomAnswer(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  if (question.allowCustomAnswer === false) {
    return draft ?? {};
  }

  const selectedOptionValues =
    customAnswer.trim().length > 0
      ? undefined
      : normalizeSelectedOptionValues(question, draft?.selectedOptionValues);
  return {
    customAnswer,
    ...(selectedOptionValues && selectedOptionValues.length > 0 ? { selectedOptionValues } : {}),
  };
}

export function isPendingUserInputOptionSelected(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionValue: string,
): boolean {
  if (question.allowCustomAnswer !== false && normalizeDraftAnswer(draft?.customAnswer)) {
    return false;
  }

  const resolvedOptionValue = resolvePendingUserInputOptionValue(question, optionValue);
  return (
    resolvedOptionValue !== null &&
    normalizeSelectedOptionValues(question, draft?.selectedOptionValues).includes(
      resolvedOptionValue,
    )
  );
}

export function togglePendingUserInputOptionSelection(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionValue: string,
): PendingUserInputDraftAnswer {
  const resolvedOptionValue = resolvePendingUserInputOptionValue(question, optionValue);
  if (resolvedOptionValue === null) {
    return draft ?? {};
  }

  if (question.multiSelect) {
    const selectedOptionValues = normalizeSelectedOptionValues(
      question,
      draft?.selectedOptionValues,
    );
    const nextSelectedOptionValues = selectedOptionValues.includes(resolvedOptionValue)
      ? selectedOptionValues.filter((value) => value !== resolvedOptionValue)
      : [...selectedOptionValues, resolvedOptionValue];

    return {
      customAnswer: "",
      ...(nextSelectedOptionValues.length > 0
        ? { selectedOptionValues: nextSelectedOptionValues }
        : {}),
    };
  }

  return {
    customAnswer: "",
    selectedOptionValues: [resolvedOptionValue],
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string | ReadonlyArray<string>> | null {
  const answers: Record<string, string | ReadonlyArray<string>> = {};

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(question, draftAnswers[question.id]);
    if (answer === null) {
      return null;
    }
    answers[question.id] = answer;
  }

  return answers;
}

export function buildThreadFeed(
  thread: Pick<OrchestrationThread, "messages" | "activities">,
  options?: {
    readonly loadedMessages?: ReadonlyArray<OrchestrationThread["messages"][number]>;
    readonly localMessages?: ReadonlyArray<OrchestrationThread["messages"][number]>;
  },
): ThreadFeedEntry[] {
  const loadedMessages = options?.loadedMessages ?? thread.messages;
  const messages = options?.localMessages
    ? [...loadedMessages, ...options.localMessages]
    : loadedMessages;
  const oldestLoadedMessageCreatedAt =
    options?.loadedMessages !== undefined ? (loadedMessages[0]?.createdAt ?? null) : null;
  const activityEntries = getThreadFeedActivityEntries(thread.activities);
  const entries = Arr.sortWith(
    [
      ...messages.map((message) => {
        let entry = messageEntriesCache.get(message);
        if (!entry) {
          entry = { type: "message", id: message.id, createdAt: message.createdAt, message };
          messageEntriesCache.set(message, entry);
        }
        return entry;
      }),
      ...activityEntries.filter(
        (entry) =>
          oldestLoadedMessageCreatedAt === null || entry.createdAt >= oldestLoadedMessageCreatedAt,
      ),
    ],
    (s) => new Date(s.createdAt),
    Order.Date,
  );

  return groupAdjacentActivities(entries);
}

function getThreadFeedActivityEntries(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  const cached = activityEntriesCache.get(activities);
  if (cached) return cached;
  const entries = deriveWorkLogEntries(activities).map(toThreadFeedActivityEntry);
  activityEntriesCache.set(activities, entries);
  return entries;
}

function toThreadFeedActivityEntry(
  entry: DerivedWorkLogEntry,
): Extract<RawThreadFeedEntry, { readonly type: "activity" }> {
  const summary = workEntryHeading(entry);
  const detail = workEntryPreview(entry);
  const getFullDetail = memoizeValue(() => buildWorkEntryExpandedBody(entry));
  const getCopyText = memoizeValue(() => {
    const copyLabel = capitalizePhrase(normalizeCompactToolLabel(entry.toolTitle || entry.label));
    const fullDetail = getFullDetail();
    if (entry.command) {
      const normalizedCommand =
        entry.rawCommand && copyLabel.trim() !== entry.command.trim() ? entry.command : null;
      return [copyLabel, normalizedCommand, fullDetail ?? entry.command]
        .filter((value): value is string => Boolean(value))
        .join("\n");
    }
    return [copyLabel, detail, fullDetail]
      .filter((value, index, values): value is string => {
        return Boolean(value) && values.indexOf(value) === index;
      })
      .join("\n");
  });
  return {
    type: "activity",
    id: entry.id,
    createdAt: entry.createdAt,
    turnId: entry.turnId,
    activity: {
      id: entry.id,
      createdAt: entry.createdAt,
      turnId: entry.turnId,
      summary,
      detail,
      canExpand: workEntryHasExpandedBody(entry, workEntryRowLabel(entry)),
      getFullDetail,
      getCopyText,
      icon: workEntryIcon(entry),
      toolLike: workLogEntryIsToolLike(entry),
      status: workEntryStatus(entry),
      ...(entry.toolLifecycleStatus ? { lifecycleStatus: entry.toolLifecycleStatus } : {}),
      workEntry: entry,
    },
  };
}
