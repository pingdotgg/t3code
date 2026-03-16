import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  type ProviderKind,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  type TurnId,
} from "@t3tools/contracts";

import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  ThreadSession,
  TurnDiffSummary,
} from "./types";

export type ProviderPickerKind = ProviderKind | "cursor";

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
}> = [
  { value: "codex", label: "Codex", available: true },
  { value: "claudeCode", label: "Claude Code", available: true },
  { value: "cursor", label: "Cursor", available: false },
];

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  label: string;
  detail?: string;
  command?: string;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
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
}

export type AgentTeamsTaskStatus =
  | "lead"
  | "running"
  | "idle"
  | "awaitingApproval"
  | "completed"
  | "failed"
  | "stopped";

export interface AgentTeamsActivity {
  id: string;
  kind: string;
  updatedAt: string;
  label: string;
  detail?: string;
  status?: Exclude<AgentTeamsTaskStatus, "lead">;
  runId?: string;
  statusSource?: string;
  taskId?: string;
  toolUseId?: string;
  lastToolName?: string;
}

export interface AgentTeamsTaskSnapshot {
  taskId?: string;
  teammateName?: string;
  summary?: string;
  status?: string;
  updatedAt?: string;
}

interface AgentTeamsMemberSnapshot {
  agentId?: string;
  teammateName?: string;
  agentName?: string;
  agentColor?: string;
  agentType?: string;
}

export interface AgentTeamsMember {
  id: string;
  label: string;
  status: Exclude<AgentTeamsTaskStatus, "lead">;
  updatedAt: string;
  startedAt: string;
  detail?: string;
  agentId?: string;
  agentName?: string;
  agentColor?: string;
  agentType?: string;
  teamName?: string;
  taskId?: string;
  toolUseId?: string;
  teammateName?: string;
  teammateMode?: string;
  statusSource?: string;
  planModeRequired?: boolean;
  awaitingLeaderApproval?: boolean;
  activities: AgentTeamsActivity[];
}

export interface AgentTeamsRun {
  id: string;
  label: string;
  status: Exclude<AgentTeamsTaskStatus, "lead">;
  startedAt: string;
  endedAt?: string;
  startedActivityId: string;
  endedActivityId?: string;
  teamName?: string;
  teammateMode?: string;
  statusSource?: string;
  tasks?: AgentTeamsTaskSnapshot[];
  members: AgentTeamsMember[];
  activeCount: number;
  pendingApprovalCount: number;
}

export interface AgentTeamsState {
  leadLabel: string;
  runs: AgentTeamsRun[];
  activeRunId: string | null;
  hasTeamActivity: boolean;
  activeCount: number;
  pendingApprovalCount: number;
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
      kind: "team-run";
      createdAt: string;
      run: {
        runId: string;
        label: string;
        startedAt: string;
        endedAt?: string;
        memberCount?: number;
        summary: string;
      };
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
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
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
      detail?.includes("Unknown pending permission request")
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
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;

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
  const candidates = ordered.filter((activity) => {
    if (activity.kind !== "turn.plan.updated") {
      return false;
    }
    if (!latestTurnId) {
      return true;
    }
    return activity.turnId === latestTurnId;
  });
  const latest = candidates.at(-1);
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
      return {
        id: matchingTurnPlan.id,
        createdAt: matchingTurnPlan.createdAt,
        updatedAt: matchingTurnPlan.updatedAt,
        turnId: matchingTurnPlan.turnId,
        planMarkdown: matchingTurnPlan.planMarkdown,
      };
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

  return {
    id: latestPlan.id,
    createdAt: latestPlan.createdAt,
    updatedAt: latestPlan.updatedAt,
    turnId: latestPlan.turnId,
    planMarkdown: latestPlan.planMarkdown,
  };
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): WorkLogEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  return ordered
    .filter((activity) => (latestTurnId ? activity.turnId === latestTurnId : true))
    .filter((activity) => activity.kind !== "tool.started")
    .filter((activity) => activity.kind !== "task.started" && activity.kind !== "task.completed")
    .filter((activity) => activity.summary !== "Checkpoint captured")
    .map((activity) => {
      const payload =
        activity.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : null;
      const command = extractToolCommand(payload);
      const changedFiles = extractChangedFiles(payload);
      const title = extractToolTitle(payload);
      const entry: WorkLogEntry = {
        id: activity.id,
        createdAt: activity.createdAt,
        label: activity.summary,
        tone: activity.tone === "approval" ? "info" : activity.tone,
      };
      const itemType = extractWorkLogItemType(payload);
      const requestKind = extractWorkLogRequestKind(payload);
      if (payload && typeof payload.detail === "string" && payload.detail.length > 0) {
        const detail = stripTrailingExitCode(payload.detail).output;
        if (detail) {
          entry.detail = detail;
        }
      }
      if (command) {
        entry.command = command;
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
      return entry;
    });
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

function normalizeCommandValue(value: unknown): string | null {
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
  return parts.length > 0 ? parts.join(" ") : null;
}

function extractToolCommand(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
  ];
  return candidates.find((candidate) => candidate !== null) ?? null;
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
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

type AgentTeamMetadata = {
  readonly agentId?: string;
  readonly agentName?: string;
  readonly agentColor?: string;
  readonly runId?: string;
  readonly teamKey?: string;
  readonly statusSource?: string;
  readonly taskId?: string;
  readonly toolUseId?: string;
  readonly teammateName?: string;
  readonly teamName?: string;
  readonly agentType?: string;
  readonly parentSessionId?: string;
  readonly teammateMode?: string;
  readonly planModeRequired?: boolean;
  readonly awaitingLeaderApproval?: boolean;
};

type AgentTeamRunSnapshot = {
  readonly runId: string;
  readonly teamKey?: string;
  readonly label: string;
  readonly startedAt: string;
  readonly startedActivityId: string;
  readonly endedAt?: string;
  readonly endedActivityId?: string;
  readonly statusSource?: string;
  readonly teamName?: string;
  readonly teammateMode?: string;
  readonly members?: AgentTeamsMemberSnapshot[];
  readonly tasks?: AgentTeamsTaskSnapshot[];
};

type AgentTeamRunSnapshotIndex = {
  readonly byRunId: Map<string, AgentTeamRunSnapshot>;
  readonly byTeamKey: Map<string, AgentTeamRunSnapshot>;
};

function extractAgentTeamMetadata(payload: Record<string, unknown> | null): AgentTeamMetadata {
  const itemType = asTrimmedString(payload?.itemType);
  const allowToolInputTeamMetadata = itemType === "collab_agent_tool_call";
  const toolInput = asRecord(asRecord(payload?.data)?.input);
  const agentId = asTrimmedString(payload?.agentId);
  const agentName = asTrimmedString(payload?.agentName);
  const agentColor = asTrimmedString(payload?.agentColor);
  const runId = asTrimmedString(payload?.runId);
  const teamKey = asTrimmedString(payload?.teamKey);
  const statusSource = asTrimmedString(payload?.statusSource);
  const taskId = asTrimmedString(payload?.taskId);
  const toolUseId = asTrimmedString(payload?.toolUseId);
  const teammateName =
    asTrimmedString(payload?.teammateName) ??
    asTrimmedString(payload?.agentName) ??
    (allowToolInputTeamMetadata ? asTrimmedString(toolInput?.name) : undefined);
  const teamName =
    asTrimmedString(payload?.teamName) ??
    (allowToolInputTeamMetadata ? asTrimmedString(toolInput?.team_name) : undefined);
  const agentType =
    asTrimmedString(payload?.agentType) ??
    (allowToolInputTeamMetadata ? asTrimmedString(toolInput?.subagent_type) : undefined);
  const parentSessionId = asTrimmedString(payload?.parentSessionId);
  const teammateMode = asTrimmedString(payload?.teammateMode);
  const planModeRequired =
    typeof payload?.planModeRequired === "boolean" ? payload.planModeRequired : undefined;
  const awaitingLeaderApproval =
    typeof payload?.awaitingLeaderApproval === "boolean"
      ? payload.awaitingLeaderApproval
      : undefined;
  return {
    ...(agentId ? { agentId } : {}),
    ...(agentName ? { agentName } : {}),
    ...(agentColor ? { agentColor } : {}),
    ...(runId ? { runId } : {}),
    ...(teamKey ? { teamKey } : {}),
    ...(statusSource ? { statusSource } : {}),
    ...(taskId ? { taskId } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    ...(teammateName ? { teammateName } : {}),
    ...(teamName ? { teamName } : {}),
    ...(agentType ? { agentType } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(teammateMode ? { teammateMode } : {}),
    ...(planModeRequired !== undefined ? { planModeRequired } : {}),
    ...(awaitingLeaderApproval !== undefined ? { awaitingLeaderApproval } : {}),
  };
}

function isAgentTeamMetadata(metadata: AgentTeamMetadata): boolean {
  return Boolean(
    metadata.runId ?? metadata.teamName ?? metadata.teammateName ?? metadata.agentName,
  );
}

function mergeAgentTeamMetadata(
  direct: AgentTeamMetadata,
  fromTool: AgentTeamMetadata | undefined,
): AgentTeamMetadata {
  return {
    ...fromTool,
    ...direct,
  };
}

function extractAgentTeamRunSnapshots(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): AgentTeamRunSnapshotIndex {
  const byRunId = new Map<string, AgentTeamRunSnapshot>();
  const byTeamKey = new Map<string, AgentTeamRunSnapshot>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    if (
      activity.kind !== "team.run.started" &&
      activity.kind !== "team.run.updated" &&
      activity.kind !== "team.run.ended"
    ) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const runId = asTrimmedString(payload?.runId);
    if (!runId) {
      continue;
    }
    const existing = byRunId.get(runId);
    const teamKey = asTrimmedString(payload?.teamKey) ?? existing?.teamKey;
    const label =
      asTrimmedString(payload?.teamName) ??
      asTrimmedString(payload?.teammateName) ??
      existing?.label ??
      "Team";
    const members = Array.isArray(payload?.members)
      ? payload.members
          .map((member) => asRecord(member))
          .filter((member): member is Record<string, unknown> => member !== null)
          .map((member) => {
            const snapshot: AgentTeamsMemberSnapshot = {};
            const agentId = asTrimmedString(member.agentId);
            const teammateName = asTrimmedString(member.teammateName);
            const agentName = asTrimmedString(member.agentName);
            const agentColor = asTrimmedString(member.agentColor);
            const agentType = asTrimmedString(member.agentType);
            if (agentId) {
              snapshot.agentId = agentId;
            }
            if (teammateName) {
              snapshot.teammateName = teammateName;
            }
            if (agentName) {
              snapshot.agentName = agentName;
            }
            if (agentColor) {
              snapshot.agentColor = agentColor;
            }
            if (agentType) {
              snapshot.agentType = agentType;
            }
            return snapshot;
          })
          .filter(
            (member) =>
              member.agentId !== undefined ||
              member.teammateName !== undefined ||
              member.agentName !== undefined ||
              member.agentColor !== undefined ||
              member.agentType !== undefined,
          )
      : existing?.members;
    const tasks = Array.isArray(payload?.tasks)
      ? payload.tasks
          .map((task) => asRecord(task))
          .filter((task): task is Record<string, unknown> => task !== null)
          .map((task) => {
            const snapshot: AgentTeamsTaskSnapshot = {};
            const taskId = asTrimmedString(task.taskId);
            const teammateName = asTrimmedString(task.teammateName);
            const summary = asTrimmedString(task.summary);
            const status = asTrimmedString(task.status);
            const updatedAt = asTrimmedString(task.updatedAt);
            if (taskId) {
              snapshot.taskId = taskId;
            }
            if (teammateName) {
              snapshot.teammateName = teammateName;
            }
            if (summary) {
              snapshot.summary = summary;
            }
            if (status) {
              snapshot.status = status;
            }
            if (updatedAt) {
              snapshot.updatedAt = updatedAt;
            }
            return snapshot;
          })
      : existing?.tasks;
    const snapshot: AgentTeamRunSnapshot = {
      runId,
      ...(teamKey ? { teamKey } : {}),
      label,
      startedAt: asTrimmedString(payload?.startedAt) ?? existing?.startedAt ?? activity.createdAt,
      startedActivityId: existing?.startedActivityId ?? activity.id,
      ...(activity.kind === "team.run.ended"
        ? {
            endedAt: asTrimmedString(payload?.endedAt) ?? activity.createdAt,
            endedActivityId: activity.id,
          }
        : existing?.endedAt
          ? {
              endedAt: existing.endedAt,
              ...(existing.endedActivityId ? { endedActivityId: existing.endedActivityId } : {}),
            }
          : {}),
      ...(asTrimmedString(payload?.statusSource)
        ? { statusSource: asTrimmedString(payload?.statusSource)! }
        : existing?.statusSource
          ? { statusSource: existing.statusSource }
          : {}),
      ...(asTrimmedString(payload?.teamName)
        ? { teamName: asTrimmedString(payload?.teamName)! }
        : existing?.teamName
          ? { teamName: existing.teamName }
          : {}),
      ...(asTrimmedString(payload?.teammateMode)
        ? { teammateMode: asTrimmedString(payload?.teammateMode)! }
        : existing?.teammateMode
          ? { teammateMode: existing.teammateMode }
          : {}),
      ...(members && members.length > 0 ? { members } : {}),
      ...(tasks && tasks.length > 0 ? { tasks } : {}),
    };
    byRunId.set(runId, snapshot);
    if (teamKey) {
      byTeamKey.set(teamKey, snapshot);
    }
  }

  return {
    byRunId,
    byTeamKey,
  };
}

function teamMemberLabel(metadata: AgentTeamMetadata): string {
  return metadata.teammateName ?? metadata.agentName ?? "Teammate";
}

function isPlaceholderAgentTeamsLabel(value: string | undefined): boolean {
  if (!value) {
    return true;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === "teammate" ||
    normalized === "agent" ||
    normalized === "subagent" ||
    normalized === "task"
  );
}

function inferTeammateLabelFromActivity(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown>,
): string | undefined {
  const detail = asTrimmedString(payload.detail);
  if (detail) {
    const detailMatch = /^(?<label>[^:]+):/.exec(detail);
    const candidate = detailMatch?.groups?.label?.trim();
    if (candidate) {
      return candidate;
    }
  }

  const summary = activity.summary.trim();
  const summaryMatch = /^(?<label>.+?)\s+(started|update|completed|failed|stopped|idle)$/i.exec(
    summary,
  );
  const summaryCandidate = summaryMatch?.groups?.label?.trim();
  if (summaryCandidate && summaryCandidate.toLowerCase() !== "teammate") {
    return summaryCandidate;
  }

  return undefined;
}

function choosePreferredTeamMemberLabel(input: {
  readonly currentLabel: string | undefined;
  readonly nextLabel: string;
  readonly metadata: AgentTeamMetadata;
}): string {
  const { currentLabel, nextLabel, metadata } = input;
  if (!currentLabel) {
    return nextLabel;
  }
  const currentIsPlaceholder = isPlaceholderAgentTeamsLabel(currentLabel);
  const nextIsPlaceholder = isPlaceholderAgentTeamsLabel(nextLabel);
  if (currentIsPlaceholder && !nextIsPlaceholder) {
    return nextLabel;
  }
  if (!currentIsPlaceholder && nextIsPlaceholder) {
    return currentLabel;
  }
  if (metadata.teammateName || metadata.agentName) {
    return nextLabel;
  }
  return currentLabel;
}

function agentTeamsMemberKey(metadata: AgentTeamMetadata, fallbackId: string): string {
  const stableLabel = !isPlaceholderAgentTeamsLabel(metadata.teammateName ?? metadata.agentName)
    ? (metadata.teammateName ?? metadata.agentName)
    : undefined;
  const labelKey = [metadata.teamName, stableLabel].filter(Boolean).join(":");
  const candidates = [
    metadata.agentId,
    labelKey || undefined,
    metadata.toolUseId,
    metadata.taskId,
    stableLabel,
    fallbackId,
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate)) ?? fallbackId;
}

function agentTeamsStatusFromKind(kind: string): Exclude<AgentTeamsTaskStatus, "lead"> | undefined {
  switch (kind) {
    case "teammate.started":
    case "teammate.progress":
    case "tool.started":
    case "tool.updated":
      return "running";
    case "tool.completed":
      return "idle";
    case "teammate.idle":
      return "idle";
    case "teammate.awaiting-approval":
      return "awaitingApproval";
    case "teammate.completed":
      return "completed";
    case "teammate.failed":
      return "failed";
    case "teammate.stopped":
      return "stopped";
    default:
      // For task.progress/task.completed of known teammate tasks (checked via
      // shouldTrackAgentTeamsActivity), derive status from the payload
      return undefined;
  }
}

function isTerminalAgentTeamsStatus(status: Exclude<AgentTeamsTaskStatus, "lead">): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

function agentTeamsActivityDetail(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown>,
): string | undefined {
  return (
    asTrimmedString(payload.summary) ??
    asTrimmedString(payload.detail) ??
    asTrimmedString(payload.lastToolName) ??
    (activity.kind.startsWith("tool.") ? activity.summary : undefined)
  );
}

function shouldTrackAgentTeamsActivity(
  activity: OrchestrationThreadActivity,
  metadata: AgentTeamMetadata,
  teammateTaskIds?: Set<string>,
): boolean {
  if (activity.kind.startsWith("team.run.")) {
    return false;
  }
  if (isAgentTeamMetadata(metadata)) {
    return true;
  }
  if (
    (activity.kind === "tool.started" ||
      activity.kind === "tool.updated" ||
      activity.kind === "tool.completed") &&
    typeof activity.payload === "object" &&
    activity.payload !== null &&
    (activity.payload as Record<string, unknown>).itemType === "collab_agent_tool_call"
  ) {
    return true;
  }
  // Recognize task.progress/task.completed for known teammate tasks
  if (
    teammateTaskIds &&
    (activity.kind === "task.progress" || activity.kind === "task.completed") &&
    typeof activity.payload === "object" &&
    activity.payload !== null
  ) {
    const taskId = asTrimmedString((activity.payload as Record<string, unknown>).taskId);
    if (taskId && teammateTaskIds.has(taskId)) {
      return true;
    }
  }
  return activity.kind.startsWith("teammate.");
}

type MutableAgentTeamsMember = Omit<AgentTeamsMember, "activities"> & {
  activities: AgentTeamsActivity[];
};

type MutableAgentTeamsRun = Omit<
  AgentTeamsRun,
  "members" | "status" | "activeCount" | "pendingApprovalCount"
> & {
  members: Map<string, MutableAgentTeamsMember>;
  order: string[];
};

function snapshotTeamMetadata(
  run: Pick<MutableAgentTeamsRun, "teamName" | "statusSource" | "teammateMode">,
  member: AgentTeamsMemberSnapshot,
  task?: AgentTeamsTaskSnapshot,
): AgentTeamMetadata {
  return {
    ...(member.agentId ? { agentId: member.agentId } : {}),
    ...(member.agentName ? { agentName: member.agentName } : {}),
    ...(member.agentColor ? { agentColor: member.agentColor } : {}),
    ...(member.agentType ? { agentType: member.agentType } : {}),
    ...(member.teammateName ? { teammateName: member.teammateName } : {}),
    ...(run.teamName ? { teamName: run.teamName } : {}),
    ...(run.statusSource ? { statusSource: run.statusSource } : {}),
    ...(run.teammateMode ? { teammateMode: run.teammateMode } : {}),
    ...(task?.taskId ? { taskId: task.taskId } : {}),
  };
}

function statusFromTaskSnapshot(
  status: string | undefined,
): Exclude<AgentTeamsTaskStatus, "lead"> | undefined {
  switch (status) {
    case "running":
      return "running";
    case "idle":
      return "idle";
    case "awaitingApproval":
      return "awaitingApproval";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return undefined;
  }
}

function seedRunMembersFromSnapshot(
  run: MutableAgentTeamsRun,
  snapshot: AgentTeamRunSnapshot | undefined,
): void {
  if (!snapshot) {
    return;
  }

  const taskByMemberLabel = new Map<string, AgentTeamsTaskSnapshot>();
  for (const task of snapshot.tasks ?? []) {
    const key = task.teammateName?.trim().toLowerCase();
    if (!key || taskByMemberLabel.has(key)) {
      continue;
    }
    taskByMemberLabel.set(key, task);
  }

  const touchMemberFromSnapshot = (
    metadata: AgentTeamMetadata,
    task: AgentTeamsTaskSnapshot | undefined,
  ) => {
    const labelKey = (metadata.teammateName ?? metadata.agentName)?.trim().toLowerCase();
    const memberId = agentTeamsMemberKey(metadata, `snapshot:${run.id}:${run.order.length + 1}`);
    let member = run.members.get(memberId) ?? matchingMemberForMetadata(run, metadata);
    const detail = task?.summary;
    const status = statusFromTaskSnapshot(task?.status) ?? (run.endedAt ? "completed" : "running");
    const updatedAt = task?.updatedAt ?? run.startedAt;
    const nextLabel = teamMemberLabel(metadata);

    if (!member) {
      member = {
        id: memberId,
        label: nextLabel,
        status,
        updatedAt,
        startedAt: run.startedAt,
        ...(detail ? { detail } : {}),
        ...(metadata.agentId ? { agentId: metadata.agentId } : {}),
        ...(metadata.agentName ? { agentName: metadata.agentName } : {}),
        ...(metadata.agentColor ? { agentColor: metadata.agentColor } : {}),
        ...(metadata.agentType ? { agentType: metadata.agentType } : {}),
        ...(metadata.teamName ? { teamName: metadata.teamName } : {}),
        ...(metadata.taskId ? { taskId: metadata.taskId } : {}),
        ...(metadata.teammateName ? { teammateName: metadata.teammateName } : {}),
        ...(metadata.teammateMode ? { teammateMode: metadata.teammateMode } : {}),
        ...(metadata.statusSource ? { statusSource: metadata.statusSource } : {}),
        activities: [],
      };
      run.members.set(memberId, member);
      run.order.push(memberId);
    } else {
      member.label = choosePreferredTeamMemberLabel({
        currentLabel: member.label,
        nextLabel,
        metadata,
      });
      member.status = isTerminalAgentTeamsStatus(member.status) ? member.status : status;
      member.updatedAt =
        member.updatedAt.localeCompare(updatedAt) > 0 ? member.updatedAt : updatedAt;
      if (!member.detail && detail) {
        member.detail = detail;
      }
    }

    if (metadata.agentId) {
      member.agentId = metadata.agentId;
    }
    if (metadata.agentName) {
      member.agentName = metadata.agentName;
    }
    if (metadata.agentColor) {
      member.agentColor = metadata.agentColor;
    }
    if (metadata.agentType) {
      member.agentType = metadata.agentType;
    }
    if (metadata.teamName) {
      member.teamName = metadata.teamName;
    }
    if (metadata.taskId) {
      member.taskId = metadata.taskId;
    }
    if (metadata.teammateName) {
      member.teammateName = metadata.teammateName;
    }
    if (metadata.teammateMode) {
      member.teammateMode = metadata.teammateMode;
    }
    if (metadata.statusSource) {
      member.statusSource = metadata.statusSource;
    }

    if (labelKey) {
      taskByMemberLabel.delete(labelKey);
    }
  };

  for (const memberSnapshot of snapshot.members ?? []) {
    const labelKey = (memberSnapshot.teammateName ?? memberSnapshot.agentName)
      ?.trim()
      .toLowerCase();
    const matchingTask =
      snapshot.tasks?.find((task) => {
        if (labelKey && task.teammateName?.trim().toLowerCase() === labelKey) {
          return true;
        }
        return false;
      }) ?? (labelKey ? taskByMemberLabel.get(labelKey) : undefined);
    touchMemberFromSnapshot(snapshotTeamMetadata(run, memberSnapshot, matchingTask), matchingTask);
  }

  for (const task of taskByMemberLabel.values()) {
    if (!task.teammateName) {
      continue;
    }
    touchMemberFromSnapshot(
      {
        teammateName: task.teammateName,
        ...(run.teamName ? { teamName: run.teamName } : {}),
        ...(run.statusSource ? { statusSource: run.statusSource } : {}),
        ...(run.teammateMode ? { teammateMode: run.teammateMode } : {}),
        ...(task.taskId ? { taskId: task.taskId } : {}),
      },
      task,
    );
  }
}

function isLeadCoordinationTool(payload: Record<string, unknown>): boolean {
  const detail = asTrimmedString(payload.detail);
  if (!detail) return false;
  return (
    detail.startsWith("TeamCreate") ||
    detail.startsWith("TeamDelete") ||
    detail.startsWith("TeamUpdate") ||
    detail.startsWith("SendMessage") ||
    detail.startsWith("TaskCreate") ||
    detail.startsWith("TaskUpdate") ||
    detail.startsWith("TaskDelete")
  );
}

function canCreateAgentTeamsMember(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown>,
  metadata: AgentTeamMetadata,
): boolean {
  // Lead coordination tools (TeamCreate, TeamDelete, SendMessage) should
  // NOT create new team members — they are actions by the lead, not teammates.
  if (isLeadCoordinationTool(payload)) {
    return false;
  }
  if (activity.kind.startsWith("teammate.")) {
    return true;
  }
  if (
    (activity.kind === "tool.started" ||
      activity.kind === "tool.updated" ||
      activity.kind === "tool.completed") &&
    payload.itemType === "collab_agent_tool_call"
  ) {
    return true;
  }
  return Boolean(
    metadata.agentId ??
    metadata.taskId ??
    (!isPlaceholderAgentTeamsLabel(metadata.teammateName ?? metadata.agentName)
      ? (metadata.teammateName ?? metadata.agentName)
      : undefined),
  );
}

function matchingMemberForMetadata(
  run: MutableAgentTeamsRun,
  metadata: AgentTeamMetadata,
): MutableAgentTeamsMember | undefined {
  const candidateNames = [metadata.teammateName, metadata.agentName].filter(
    (value): value is string => value !== undefined,
  );
  for (const member of run.members.values()) {
    if (metadata.agentId && member.agentId === metadata.agentId) {
      return member;
    }
    if (metadata.toolUseId && member.toolUseId === metadata.toolUseId) {
      return member;
    }
    if (metadata.taskId && member.taskId === metadata.taskId) {
      return member;
    }
    if (
      metadata.teamName &&
      member.teamName === metadata.teamName &&
      candidateNames.some(
        (candidateName) =>
          member.teammateName === candidateName || member.agentName === candidateName,
      )
    ) {
      return member;
    }
  }
  return undefined;
}

export function deriveAgentTeamsState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): AgentTeamsState {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const explicitRunSnapshots = extractAgentTeamRunSnapshots(ordered);
  const toolMetadataByToolUseId = new Map<string, AgentTeamMetadata>();
  const teammateTaskIds = new Set<string>();
  const taskIdToMetadata = new Map<string, AgentTeamMetadata>();

  for (const activity of ordered) {
    if (!activity.payload || typeof activity.payload !== "object") {
      continue;
    }
    const payload = activity.payload as Record<string, unknown>;

    // Track taskIds that belong to teammate tasks (any mode: in_process, tmux, etc.)
    // Only trust taskType-based detection for task.started to avoid false positives
    // from regular tasks that happen to carry team-like metadata fields.
    if (
      activity.kind === "teammate.started" ||
      (activity.kind === "task.started" &&
        (asTrimmedString(payload.taskType) === "in_process_teammate" ||
          asTrimmedString(payload.taskType) === "external_teammate"))
    ) {
      const taskId = asTrimmedString(payload.taskId);
      if (taskId) {
        teammateTaskIds.add(taskId);
        const meta = extractAgentTeamMetadata(payload);
        taskIdToMetadata.set(taskId, meta);
      }
    }

    if (
      !(
        (activity.kind === "tool.started" ||
          activity.kind === "tool.updated" ||
          activity.kind === "tool.completed") &&
        payload.itemType === "collab_agent_tool_call"
      )
    ) {
      continue;
    }
    const metadata = extractAgentTeamMetadata(payload);
    if (!metadata.toolUseId) {
      continue;
    }
    toolMetadataByToolUseId.set(metadata.toolUseId, metadata);
  }

  const runs: MutableAgentTeamsRun[] = [];
  const activeRunByTeamKey = new Map<string, MutableAgentTeamsRun>();
  const runCountByTeamKey = new Map<string, number>();

  for (const activity of ordered) {
    if (!activity.payload || typeof activity.payload !== "object") {
      continue;
    }
    const payload = activity.payload as Record<string, unknown>;
    const directMetadata = extractAgentTeamMetadata(payload);
    // For task.progress/task.completed (not teammate.*) of known teammate tasks, merge original metadata
    const taskId = asTrimmedString(payload.taskId);
    const taskOriginalMeta =
      taskId &&
      teammateTaskIds.has(taskId) &&
      !activity.kind.startsWith("teammate.")
        ? taskIdToMetadata.get(taskId)
        : undefined;
    const metadata = mergeAgentTeamMetadata(
      directMetadata,
      taskOriginalMeta ??
        (directMetadata.toolUseId
          ? toolMetadataByToolUseId.get(directMetadata.toolUseId)
          : undefined),
    );
    // Treat TeamDelete tool.completed as a team shutdown signal
    const isTeamDeleteCompleted =
      activity.kind === "tool.completed" &&
      asTrimmedString(payload.detail)?.startsWith("TeamDelete");

    // Handle explicit team.run.ended (and TeamDelete) before the shouldTrack filter
    if (activity.kind === "team.run.ended" || isTeamDeleteCompleted) {
      const endRunId = asTrimmedString(payload.runId);
      const endTeamKey =
        metadata.teamKey ?? metadata.runId ?? metadata.teamName ?? metadata.parentSessionId;
      const endingRun =
        (endTeamKey ? activeRunByTeamKey.get(endTeamKey) : undefined) ??
        [...activeRunByTeamKey.values()].find((r) => endRunId && r.id === endRunId);
      if (endingRun) {
        endingRun.endedAt = asTrimmedString(payload.endedAt) ?? activity.createdAt;
        endingRun.endedActivityId = activity.id;
        for (const member of endingRun.members.values()) {
          if (!isTerminalAgentTeamsStatus(member.status)) {
            member.status = "completed";
            member.updatedAt = activity.createdAt;
          }
        }
        for (const [key, run] of activeRunByTeamKey) {
          if (run === endingRun) {
            activeRunByTeamKey.delete(key);
          }
        }
      }
      continue;
    }

    if (!shouldTrackAgentTeamsActivity(activity, metadata, teammateTaskIds)) {
      continue;
    }

    // Skip lead coordination tools — they don't represent teammates
    if (isLeadCoordinationTool(payload)) {
      // For SendMessage, try to route the activity to the target member
      const sendDetail = asTrimmedString(payload.detail);
      if (sendDetail?.startsWith("SendMessage to ")) {
        const sendTarget = sendDetail.slice("SendMessage to ".length).split(":")[0]?.trim();
        if (sendTarget) {
          const teamKey =
            metadata.teamKey ??
            metadata.runId ??
            metadata.teamName ??
            metadata.parentSessionId ??
            (activity.turnId ? `turn:${activity.turnId}` : "agent-team");
          const run = activeRunByTeamKey.get(teamKey);
          if (run) {
            for (const member of run.members.values()) {
              if (
                member.teammateName === sendTarget ||
                member.agentName === sendTarget ||
                member.label === sendTarget
              ) {
                member.activities.push({
                  id: activity.id,
                  kind: activity.kind,
                  updatedAt: activity.createdAt,
                  label: sendDetail,
                  detail: sendDetail,
                });
                member.updatedAt = activity.createdAt;
                break;
              }
            }
          }
        }
      }
      continue;
    }

    const inferredLabel = inferTeammateLabelFromActivity(activity, payload);
    const metadataWithFallbackLabel =
      inferredLabel && !metadata.teammateName && !metadata.agentName
        ? mergeAgentTeamMetadata(metadata, { teammateName: inferredLabel })
        : metadata;

    const explicitTeamKey =
      metadataWithFallbackLabel.teamKey ??
      metadataWithFallbackLabel.runId ??
      metadataWithFallbackLabel.teamName ??
      metadataWithFallbackLabel.parentSessionId;
    const teamKey = explicitTeamKey ?? (activity.turnId ? `turn:${activity.turnId}` : "agent-team");
    const explicitRunSnapshot =
      (metadataWithFallbackLabel.runId
        ? explicitRunSnapshots.byRunId.get(metadataWithFallbackLabel.runId)
        : undefined) ??
      (metadataWithFallbackLabel.teamKey
        ? explicitRunSnapshots.byTeamKey.get(metadataWithFallbackLabel.teamKey)
        : undefined) ??
      explicitRunSnapshots.byTeamKey.get(teamKey);
    const status = agentTeamsStatusFromKind(activity.kind);

    let run =
      activeRunByTeamKey.get(teamKey) ??
      (metadataWithFallbackLabel.runId
        ? runs.find((r) => r.endedAt && r.id === metadataWithFallbackLabel.runId)
        : undefined);
    if (!run) {
      const runNumber = (runCountByTeamKey.get(teamKey) ?? 0) + 1;
      runCountByTeamKey.set(teamKey, runNumber);
      run = {
        id: explicitRunSnapshot?.runId ?? `${teamKey}:${runNumber}`,
        label:
          explicitRunSnapshot?.label ??
          metadataWithFallbackLabel.teamName ??
          inferredLabel ??
          `Team ${runNumber}`,
        startedAt: explicitRunSnapshot?.startedAt ?? activity.createdAt,
        startedActivityId: explicitRunSnapshot?.startedActivityId ?? activity.id,
        ...(explicitRunSnapshot?.teamName
          ? { teamName: explicitRunSnapshot.teamName }
          : metadataWithFallbackLabel.teamName
            ? { teamName: metadataWithFallbackLabel.teamName }
            : {}),
        ...(explicitRunSnapshot?.teammateMode
          ? { teammateMode: explicitRunSnapshot.teammateMode }
          : metadataWithFallbackLabel.teammateMode
            ? { teammateMode: metadataWithFallbackLabel.teammateMode }
            : {}),
        ...(explicitRunSnapshot?.statusSource
          ? { statusSource: explicitRunSnapshot.statusSource }
          : metadataWithFallbackLabel.statusSource
            ? { statusSource: metadataWithFallbackLabel.statusSource }
            : {}),
        ...(explicitRunSnapshot?.tasks ? { tasks: explicitRunSnapshot.tasks } : {}),
        members: new Map<string, MutableAgentTeamsMember>(),
        order: [],
      };
      seedRunMembersFromSnapshot(run, explicitRunSnapshot);
      runs.push(run);
      activeRunByTeamKey.set(teamKey, run);
    } else {
      if (explicitRunSnapshot && run.id !== explicitRunSnapshot.runId) {
        run.id = explicitRunSnapshot.runId;
      }
      if (!run.teamName && metadataWithFallbackLabel.teamName) {
        run.teamName = metadataWithFallbackLabel.teamName;
        run.label = metadataWithFallbackLabel.teamName;
      }
    }

    if (!run.teammateMode && metadataWithFallbackLabel.teammateMode) {
      run.teammateMode = metadataWithFallbackLabel.teammateMode;
    }
    if (!run.statusSource && metadataWithFallbackLabel.statusSource) {
      run.statusSource = metadataWithFallbackLabel.statusSource;
    }
    if (!run.tasks && explicitRunSnapshot?.tasks) {
      run.tasks = explicitRunSnapshot.tasks;
    }
    seedRunMembersFromSnapshot(run, explicitRunSnapshot);

    const memberId = agentTeamsMemberKey(metadataWithFallbackLabel, activity.id);
    const detail = agentTeamsActivityDetail(activity, payload);
    const nextLabel = teamMemberLabel(metadataWithFallbackLabel);

    let member =
      run.members.get(memberId) ?? matchingMemberForMetadata(run, metadataWithFallbackLabel);
    if (!member) {
      if (!canCreateAgentTeamsMember(activity, payload, metadataWithFallbackLabel)) {
        continue;
      }
      member = {
        id: memberId,
        label: nextLabel,
        status: status ?? "running",
        updatedAt: activity.createdAt,
        startedAt: activity.createdAt,
        ...(detail ? { detail } : {}),
        ...(metadataWithFallbackLabel.agentId
          ? { agentId: metadataWithFallbackLabel.agentId }
          : {}),
        ...(metadataWithFallbackLabel.agentName
          ? { agentName: metadataWithFallbackLabel.agentName }
          : {}),
        ...(metadataWithFallbackLabel.agentColor
          ? { agentColor: metadataWithFallbackLabel.agentColor }
          : {}),
        ...(metadataWithFallbackLabel.agentType
          ? { agentType: metadataWithFallbackLabel.agentType }
          : {}),
        ...(metadataWithFallbackLabel.teamName
          ? { teamName: metadataWithFallbackLabel.teamName }
          : {}),
        ...(metadataWithFallbackLabel.taskId ? { taskId: metadataWithFallbackLabel.taskId } : {}),
        ...(metadataWithFallbackLabel.toolUseId
          ? { toolUseId: metadataWithFallbackLabel.toolUseId }
          : {}),
        ...(metadataWithFallbackLabel.teammateName
          ? { teammateName: metadataWithFallbackLabel.teammateName }
          : {}),
        ...(metadataWithFallbackLabel.teammateMode
          ? { teammateMode: metadataWithFallbackLabel.teammateMode }
          : {}),
        ...(metadataWithFallbackLabel.statusSource
          ? { statusSource: metadataWithFallbackLabel.statusSource }
          : {}),
        ...(metadataWithFallbackLabel.planModeRequired !== undefined
          ? { planModeRequired: metadataWithFallbackLabel.planModeRequired }
          : {}),
        ...(metadataWithFallbackLabel.awaitingLeaderApproval !== undefined
          ? { awaitingLeaderApproval: metadataWithFallbackLabel.awaitingLeaderApproval }
          : {}),
        activities: [],
      };
      run.members.set(memberId, member);
      run.order.push(memberId);
    } else if (member.id !== memberId && metadataWithFallbackLabel.agentId) {
      const previousMemberId = member.id;
      run.members.delete(previousMemberId);
      run.members.set(memberId, {
        ...member,
        id: memberId,
      });
      run.order = run.order.map((candidateId) =>
        candidateId === previousMemberId ? memberId : candidateId,
      );
      member = run.members.get(memberId)!;
    }

    // For task.progress/task.completed of known teammate tasks, derive status from the payload
    const taskPayloadStatus =
      status === undefined && taskId && teammateTaskIds.has(taskId)
        ? activity.kind === "task.completed"
          ? (asTrimmedString(payload.status) === "failed"
              ? "failed"
              : asTrimmedString(payload.status) === "stopped"
                ? "stopped"
                : "completed")
          : activity.kind === "task.progress"
            ? "running"
            : undefined
        : undefined;
    const nextStatus = status ?? taskPayloadStatus ?? member.status;

    member.label = choosePreferredTeamMemberLabel({
      currentLabel: member.label,
      nextLabel,
      metadata: metadataWithFallbackLabel,
    });
    member.status = isTerminalAgentTeamsStatus(member.status) ? member.status : nextStatus;
    member.updatedAt = activity.createdAt;
    if (detail) {
      member.detail = detail;
    }
    if (metadataWithFallbackLabel.agentId) {
      member.agentId = metadataWithFallbackLabel.agentId;
    }
    if (metadataWithFallbackLabel.agentName) {
      member.agentName = metadataWithFallbackLabel.agentName;
    }
    if (metadataWithFallbackLabel.agentColor) {
      member.agentColor = metadataWithFallbackLabel.agentColor;
    }
    if (metadataWithFallbackLabel.agentType) {
      member.agentType = metadataWithFallbackLabel.agentType;
    }
    if (metadataWithFallbackLabel.teamName) {
      member.teamName = metadataWithFallbackLabel.teamName;
    }
    if (metadataWithFallbackLabel.taskId) {
      member.taskId = metadataWithFallbackLabel.taskId;
    }
    if (metadataWithFallbackLabel.toolUseId) {
      member.toolUseId = metadataWithFallbackLabel.toolUseId;
    }
    if (metadataWithFallbackLabel.teammateName) {
      member.teammateName = metadataWithFallbackLabel.teammateName;
    }
    if (metadataWithFallbackLabel.teammateMode) {
      member.teammateMode = metadataWithFallbackLabel.teammateMode;
    }
    if (metadataWithFallbackLabel.statusSource) {
      member.statusSource = metadataWithFallbackLabel.statusSource;
    }
    if (metadataWithFallbackLabel.planModeRequired !== undefined) {
      member.planModeRequired = metadataWithFallbackLabel.planModeRequired;
    }
    if (metadataWithFallbackLabel.awaitingLeaderApproval !== undefined) {
      member.awaitingLeaderApproval = metadataWithFallbackLabel.awaitingLeaderApproval;
    } else if (nextStatus === "awaitingApproval") {
      member.awaitingLeaderApproval = true;
    } else if (isTerminalAgentTeamsStatus(nextStatus)) {
      member.awaitingLeaderApproval = false;
    }
    member.activities.push({
      id: activity.id,
      kind: activity.kind,
      updatedAt: activity.createdAt,
      label: activity.summary,
      ...(detail ? { detail } : {}),
      ...(status ? { status } : {}),
      ...(metadataWithFallbackLabel.runId ? { runId: metadataWithFallbackLabel.runId } : {}),
      ...(metadataWithFallbackLabel.statusSource
        ? { statusSource: metadataWithFallbackLabel.statusSource }
        : {}),
      ...(metadataWithFallbackLabel.taskId ? { taskId: metadataWithFallbackLabel.taskId } : {}),
      ...(metadataWithFallbackLabel.toolUseId
        ? { toolUseId: metadataWithFallbackLabel.toolUseId }
        : {}),
      ...(asTrimmedString(payload.lastToolName)
        ? { lastToolName: asTrimmedString(payload.lastToolName)! }
        : {}),
    });

    const hasActiveMembers = [...run.members.values()].some(
      (candidate) => !isTerminalAgentTeamsStatus(candidate.status),
    );
    if (!hasActiveMembers) {
      run.endedAt = activity.createdAt;
      run.endedActivityId = activity.id;
      activeRunByTeamKey.delete(teamKey);
    }
  }

  const finalizedRuns = runs
    .map<AgentTeamsRun>((run) => {
      const explicitRunSnapshot = explicitRunSnapshots.byRunId.get(run.id);
      const orderedMembers = run.order
        .map((memberId) => run.members.get(memberId))
        .filter((member): member is MutableAgentTeamsMember => member !== undefined)
        .toSorted(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
        );
      const hasNamedMembers = orderedMembers.some(
        (member) => !isPlaceholderAgentTeamsLabel(member.label),
      );
      const members = hasNamedMembers
        ? orderedMembers.filter(
            (member) =>
              !isPlaceholderAgentTeamsLabel(member.label) ||
              member.activities.some((activity) => !activity.kind.startsWith("tool.")),
          )
        : orderedMembers;
      // Compute endedAt first so status can account for it
      const endedAt = explicitRunSnapshot?.endedAt ?? run.endedAt;
      const endedActivityId = explicitRunSnapshot?.endedActivityId ?? run.endedActivityId;
      const runIsEnded = Boolean(endedAt);

      const activeCount = runIsEnded
        ? 0
        : members.filter(
            (member) =>
              member.status === "running" ||
              member.status === "idle" ||
              member.status === "awaitingApproval",
          ).length;
      const pendingApprovalCount = runIsEnded
        ? 0
        : members.filter((member) => member.status === "awaitingApproval").length;
      const status = runIsEnded
        ? (members.find((member) => member.status === "failed")?.status ??
          members.find((member) => member.status === "stopped")?.status ??
          "completed")
        : (members.find((member) => member.status === "awaitingApproval")?.status ??
          members.find((member) => member.status === "running")?.status ??
          members.find((member) => member.status === "idle")?.status ??
          members.find((member) => member.status === "failed")?.status ??
          members.find((member) => member.status === "stopped")?.status ??
          members.find((member) => member.status === "completed")?.status ??
          "completed");

      const finalizedRun: AgentTeamsRun = {
        id: run.id,
        label: run.label,
        status,
        startedAt: run.startedAt,
        startedActivityId: run.startedActivityId,
        members,
        activeCount,
        pendingApprovalCount,
      };
      if (run.statusSource) {
        finalizedRun.statusSource = run.statusSource;
      }
      if (run.tasks) {
        finalizedRun.tasks = run.tasks;
      }
      if (endedAt) {
        finalizedRun.endedAt = endedAt;
      }
      if (endedActivityId) {
        finalizedRun.endedActivityId = endedActivityId;
      }
      const teamName = explicitRunSnapshot?.teamName ?? run.teamName;
      if (teamName) {
        finalizedRun.teamName = teamName;
      }
      const teammateMode = explicitRunSnapshot?.teammateMode ?? run.teammateMode;
      if (teammateMode) {
        finalizedRun.teammateMode = teammateMode;
      }
      if (explicitRunSnapshot?.statusSource && !finalizedRun.statusSource) {
        finalizedRun.statusSource = explicitRunSnapshot.statusSource;
      }
      if (explicitRunSnapshot?.tasks && !finalizedRun.tasks) {
        finalizedRun.tasks = explicitRunSnapshot.tasks;
      }
      return finalizedRun;
    })
    .toSorted(
      (left, right) =>
        Number(Boolean(right.activeCount)) - Number(Boolean(left.activeCount)) ||
        right.startedAt.localeCompare(left.startedAt) ||
        left.id.localeCompare(right.id),
    );

  const activeRunId = finalizedRuns.find((run) => run.activeCount > 0)?.id ?? null;

  return {
    leadLabel: "Lead",
    runs: finalizedRuns,
    activeRunId,
    hasTeamActivity: finalizedRuns.length > 0,
    activeCount: finalizedRuns.reduce((total, run) => total + run.activeCount, 0),
    pendingApprovalCount: finalizedRuns.reduce((total, run) => total + run.pendingApprovalCount, 0),
  };
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

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
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
  activities: ReadonlyArray<OrchestrationThreadActivity>,
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
  const teamRunRows: TimelineEntry[] = [
    ...extractAgentTeamRunSnapshots(activities).byRunId.values(),
  ].map((run) => {
    const memberCount = run.members?.length ?? 0;
    const memberSuffix = memberCount > 0 ? ` with ${memberCount} agent${memberCount === 1 ? "" : "s"}` : "";
    return {
      id: `team-run-timeline:${run.runId}`,
      kind: "team-run" as const,
      createdAt: run.endedAt ?? run.startedAt,
      run: {
        runId: run.runId,
        label: run.label,
        startedAt: run.startedAt,
        ...(run.endedAt ? { endedAt: run.endedAt } : {}),
        memberCount,
        summary: run.endedAt
          ? `${run.label} completed${memberSuffix}`
          : `${run.label} in progress${memberSuffix}`,
      },
    };
  });
  return [...messageRows, ...proposedPlanRows, ...workRows, ...teamRunRows].toSorted((a, b) =>
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

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}
