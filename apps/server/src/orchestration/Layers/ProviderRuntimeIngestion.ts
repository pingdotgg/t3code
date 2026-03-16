import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  CheckpointRef,
  isToolLifecycleItemType,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { Cache, Cause, Data, Duration, Effect, Layer, Option, Ref, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { isGitRepository } from "../../git/isRepo.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${crypto.randomUUID()}`);

const DEFAULT_ASSISTANT_DELIVERY_MODE: AssistantDeliveryMode = "buffered";
const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
const BUFFERED_REASONING_BY_ID_CACHE_CAPACITY = 10_000;
const BUFFERED_REASONING_BY_ID_TTL = Duration.minutes(120);
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    };

class ClaudeArtifactSnapshotError extends Data.TaggedError("ClaudeArtifactSnapshotError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.makeUnsafe(String(value));
}

function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.makeUnsafe(value);
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function normalizeProposedPlanMarkdown(planMarkdown: string | undefined): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

function reasoningActivityIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): EventId {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return EventId.makeUnsafe(`thinking:${threadId}:turn:${turnId}`);
  }
  if (event.itemId) {
    return EventId.makeUnsafe(`thinking:${threadId}:item:${event.itemId}`);
  }
  return EventId.makeUnsafe(`thinking:${threadId}:event:${event.eventId}`);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function runtimePayloadRecord(event: ProviderRuntimeEvent): Record<string, unknown> | undefined {
  const payload = (event as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  return payload as Record<string, unknown>;
}

function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

function runtimeTurnState(
  event: ProviderRuntimeEvent,
): "completed" | "failed" | "interrupted" | "cancelled" {
  const payloadState = asString(runtimePayloadRecord(event)?.state);
  return normalizeRuntimeTurnState(payloadState);
}

function runtimeTurnErrorMessage(event: ProviderRuntimeEvent): string | undefined {
  const payloadErrorMessage = asString(runtimePayloadRecord(event)?.errorMessage);
  return payloadErrorMessage;
}

function runtimeErrorMessageFromEvent(event: ProviderRuntimeEvent): string | undefined {
  const payloadMessage = asString(runtimePayloadRecord(event)?.message);
  return payloadMessage;
}

function teamMetadataPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(asString(payload.agentId) ? { agentId: asString(payload.agentId) } : {}),
    ...(asString(payload.agentName) ? { agentName: asString(payload.agentName) } : {}),
    ...(asString(payload.agentColor) ? { agentColor: asString(payload.agentColor) } : {}),
    ...(asString(payload.agentType) ? { agentType: asString(payload.agentType) } : {}),
    ...(asString(payload.teamName) ? { teamName: asString(payload.teamName) } : {}),
    ...(asString(payload.teammateName) ? { teammateName: asString(payload.teammateName) } : {}),
    ...(asString(payload.parentSessionId)
      ? { parentSessionId: asString(payload.parentSessionId) }
      : {}),
    ...(asString(payload.teammateMode) ? { teammateMode: asString(payload.teammateMode) } : {}),
    ...(asString(payload.toolUseId) ? { toolUseId: asString(payload.toolUseId) } : {}),
    ...(asString(payload.runId) ? { runId: asString(payload.runId) } : {}),
    ...(asString(payload.teamKey) ? { teamKey: asString(payload.teamKey) } : {}),
    ...(asString(payload.statusSource) ? { statusSource: asString(payload.statusSource) } : {}),
    ...(typeof payload.planModeRequired === "boolean"
      ? { planModeRequired: payload.planModeRequired }
      : {}),
    ...(typeof payload.awaitingLeaderApproval === "boolean"
      ? { awaitingLeaderApproval: payload.awaitingLeaderApproval }
      : {}),
  };
}

function hasTeamMetadata(payload: Record<string, unknown>): boolean {
  return (
    asString(payload.runId) !== undefined ||
    asString(payload.teamName) !== undefined ||
    asString(payload.teammateName) !== undefined ||
    asString(payload.agentName) !== undefined
  );
}

function teammateActivityLabel(payload: Record<string, unknown>): string {
  return (
    asString(payload.teammateName) ??
    asString(payload.agentName) ??
    asString(payload.agentType) ??
    asString(payload.teamName) ??
    "Teammate"
  );
}

function teammateActivitySummary(
  kind: string,
  payload: Record<string, unknown>,
  fallbackSummary: string,
): string {
  const label = teammateActivityLabel(payload);
  switch (kind) {
    case "teammate.started":
      return `${label} started`;
    case "teammate.progress":
      return `${label} update`;
    case "teammate.completed":
      return `${label} completed`;
    case "teammate.failed":
      return `${label} failed`;
    case "teammate.stopped":
      return `${label} stopped`;
    default:
      return fallbackSummary;
  }
}

function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | undefined {
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
      return undefined;
  }
}

type TeamStatusSource = "runtime" | "claude-files";

type TeamArtifactMember = {
  agentId?: string;
  teammateName?: string;
  agentName?: string;
  agentColor?: string;
  agentType?: string;
};

type TeamArtifactTask = {
  taskId?: string;
  teammateName?: string;
  summary?: string;
  status?: string;
  updatedAt?: string;
};

type TeamArtifactSnapshot = {
  teamName?: string;
  members: ReadonlyArray<TeamArtifactMember>;
  tasks: ReadonlyArray<TeamArtifactTask>;
  endedAt?: string;
  endedReason?: string;
};

type TeamRunInfo = {
  readonly runId: string;
  readonly teamKey: string;
  readonly startedAt: string;
  readonly isNew: boolean;
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeTeamKey(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-");
  return normalized.replace(/^-+|-+$/g, "") || "agent-team";
}

function activeTeamRuns(activities: ReadonlyArray<OrchestrationThreadActivity>): ReadonlyArray<{
  readonly runId: string;
  readonly teamKey: string;
  readonly turnId: TurnId | null;
  readonly startedAt: string;
}> {
  const endedRunIds = new Set(
    activities
      .filter((activity) => activity.kind === "team.run.ended")
      .map((activity) => asString(asRecord(activity.payload)?.runId))
      .filter((value): value is string => value !== undefined),
  );

  return activities
    .filter((activity) => activity.kind === "team.run.started")
    .map((activity) => {
      const payload = asRecord(activity.payload);
      const runId = asString(payload?.runId);
      const teamKey = asString(payload?.teamKey);
      if (!runId || !teamKey || endedRunIds.has(runId)) {
        return null;
      }
      return {
        runId,
        teamKey,
        turnId: activity.turnId,
        startedAt: activity.createdAt,
      };
    })
    .filter(
      (
        value,
      ): value is {
        readonly runId: string;
        readonly teamKey: string;
        readonly turnId: TurnId | null;
        readonly startedAt: string;
      } => value !== null,
    );
}

function teamKeyFromPayload(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  payload: Record<string, unknown>,
  turnId: TurnId | null,
): string | undefined {
  const explicitTeamKey = asString(payload.teamKey);
  if (explicitTeamKey) {
    return explicitTeamKey;
  }

  const runId = asString(payload.runId);
  if (runId) {
    const matchingRun = activities.find(
      (activity) =>
        activity.kind === "team.run.started" &&
        asString(asRecord(activity.payload)?.runId) === runId,
    );
    const matchingRunTeamKey = asString(asRecord(matchingRun?.payload)?.teamKey);
    if (matchingRunTeamKey) {
      return matchingRunTeamKey;
    }
  }

  const openRuns = activeTeamRuns(activities);
  const sameTurnRuns =
    turnId === null ? [] : openRuns.filter((candidate) => sameId(candidate.turnId, turnId));
  if (sameTurnRuns.length === 1) {
    return sameTurnRuns[0]!.teamKey;
  }

  const explicitIdentity = asString(payload.teamName) ?? asString(payload.parentSessionId);
  if (explicitIdentity) {
    return explicitIdentity;
  }

  if (openRuns.length === 1) {
    return openRuns[0]!.teamKey;
  }

  return turnId ? `turn:${turnId}` : undefined;
}

function teamMemberKey(payload: Record<string, unknown>): string | undefined {
  return (
    asString(payload.agentId) ??
    asString(payload.toolUseId) ??
    asString(payload.taskId) ??
    asString(payload.teammateName) ??
    asString(payload.agentName)
  );
}

function teammateStatusFromKind(
  kind: string,
): "running" | "idle" | "awaitingApproval" | "completed" | "failed" | "stopped" | undefined {
  switch (kind) {
    case "teammate.started":
    case "teammate.progress":
      return "running";
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
      return undefined;
  }
}

function isTerminalTeammateStatus(
  status: ReturnType<typeof teammateStatusFromKind>,
): status is "completed" | "failed" | "stopped" {
  return status === "completed" || status === "failed" || status === "stopped";
}

function currentTeamRunInfo(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  payload: Record<string, unknown>,
  turnId: TurnId | null,
  createdAt: string,
): TeamRunInfo | null {
  const rawTeamKey = teamKeyFromPayload(activities, payload, turnId);
  if (!rawTeamKey) {
    return null;
  }
  const teamKey = normalizeTeamKey(rawTeamKey);
  const started = [...activities]
    .filter((activity) => activity.kind === "team.run.started")
    .filter((activity) => {
      const activityPayload = asRecord(activity.payload);
      return asString(activityPayload?.teamKey) === teamKey;
    })
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  const endedRunIds = new Set(activeTeamRuns(activities).map((candidate) => candidate.runId));
  const activeRun = started
    .map((activity) => {
      const activityPayload = asRecord(activity.payload);
      const runId = asString(activityPayload?.runId);
      return runId ? { runId, startedAt: activity.createdAt } : null;
    })
    .filter((value): value is { runId: string; startedAt: string } => value !== null)
    .findLast((candidate) => endedRunIds.has(candidate.runId));
  if (activeRun) {
    return {
      runId: activeRun.runId,
      teamKey,
      startedAt: activeRun.startedAt,
      isNew: false,
    };
  }
  const nextOrdinal = started.length + 1;
  return {
    runId: `team-run:${teamKey}:${nextOrdinal}`,
    teamKey,
    startedAt: createdAt,
    isNew: true,
  };
}

function runHasEnded(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  runId: string,
): boolean {
  return activities.some(
    (activity) =>
      activity.kind === "team.run.ended" && asString(asRecord(activity.payload)?.runId) === runId,
  );
}

function teamRunShouldEnd(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  currentActivity: OrchestrationThreadActivity,
  runId: string,
): boolean {
  const candidateActivities = [...activities, currentActivity].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const statuses = new Map<string, ReturnType<typeof teammateStatusFromKind>>();
  for (const activity of candidateActivities) {
    if (!activity.kind.startsWith("teammate.")) {
      continue;
    }
    const payload = asRecord(activity.payload);
    if (asString(payload?.runId) !== runId) {
      continue;
    }
    const memberKey = teamMemberKey(payload ?? {});
    if (!memberKey) {
      continue;
    }
    statuses.set(memberKey, teammateStatusFromKind(activity.kind));
  }
  if (statuses.size === 0) {
    return false;
  }
  return [...statuses.values()].every((status) => isTerminalTeammateStatus(status));
}

function teamPayloadFromArtifacts(
  payload: Record<string, unknown>,
  artifactSnapshot: TeamArtifactSnapshot | undefined,
): Record<string, unknown> {
  if (!artifactSnapshot) {
    return payload;
  }
  const runtimeAgentId = asString(payload.agentId);
  const runtimeTeammateName = asString(payload.teammateName);
  const runtimeAgentName = asString(payload.agentName);
  const runtimeTaskId = asString(payload.taskId);
  const matchingTask = artifactSnapshot.tasks.find((task) => {
    if (runtimeTaskId && task.taskId === runtimeTaskId) {
      return true;
    }
    const candidateName = task.teammateName;
    return Boolean(
      candidateName &&
      (candidateName === runtimeTeammateName ||
        candidateName === runtimeAgentName ||
        candidateName === runtimeAgentId),
    );
  });
  const matchingMember = artifactSnapshot.members.find((member) => {
    const taskTeammateName = matchingTask?.teammateName;
    return (
      (runtimeAgentId &&
        (member.agentId === runtimeAgentId ||
          member.agentName === runtimeAgentId ||
          member.teammateName === runtimeAgentId)) ||
      (runtimeTeammateName &&
        (member.teammateName === runtimeTeammateName ||
          member.agentName === runtimeTeammateName)) ||
      (runtimeAgentName &&
        (member.agentName === runtimeAgentName || member.teammateName === runtimeAgentName)) ||
      (taskTeammateName &&
        (member.teammateName === taskTeammateName || member.agentName === taskTeammateName))
    );
  });
  const artifactTeammateName = matchingTask?.teammateName ?? matchingMember?.teammateName;
  const artifactAgentName = matchingMember?.agentName ?? artifactTeammateName;
  const shouldPreferArtifactName = (value: string | undefined) =>
    value === undefined ||
    value === runtimeAgentId ||
    isUuid(value) ||
    /^agent[-_:]/i.test(value) ||
    /^subagent[-_:]/i.test(value);
  return {
    ...payload,
    ...(asString(payload.teamName)
      ? {}
      : artifactSnapshot.teamName
        ? { teamName: artifactSnapshot.teamName }
        : {}),
    ...(shouldPreferArtifactName(runtimeTeammateName)
      ? artifactTeammateName
        ? { teammateName: artifactTeammateName }
        : {}
      : {}),
    ...(shouldPreferArtifactName(runtimeAgentName)
      ? artifactAgentName
        ? { agentName: artifactAgentName }
        : {}
      : {}),
    ...(asString(payload.agentColor)
      ? {}
      : matchingMember?.agentColor
        ? { agentColor: matchingMember.agentColor }
        : {}),
    ...(asString(payload.agentType)
      ? {}
      : matchingMember?.agentType
        ? { agentType: matchingMember.agentType }
        : {}),
  };
}

function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();
  switch (event.type) {
    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            requestKind === "command"
              ? "Command approval requested"
              : requestKind === "file-read"
                ? "File-read approval requested"
                : requestKind === "file-change"
                  ? "File-change approval requested"
                  : "Approval requested",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      const message = runtimeErrorMessageFromEvent(event);
      if (!message) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(message),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          summary: "Runtime warning",
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.plan.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      const metadata = teamMetadataPayload(event.payload as Record<string, unknown>);
      const teammateLabel = teammateActivityLabel(event.payload as Record<string, unknown>);
      const isTeamTask = hasTeamMetadata(event.payload as Record<string, unknown>);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: isTeamTask ? "teammate.started" : "task.started",
          summary: isTeamTask
            ? `${teammateLabel} started`
            : event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...metadata,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      const metadata = teamMetadataPayload(event.payload as Record<string, unknown>);
      const teammateLabel = teammateActivityLabel(event.payload as Record<string, unknown>);
      const isTeamTask = hasTeamMetadata(event.payload as Record<string, unknown>);
      const awaitingLeaderApproval = event.payload.awaitingLeaderApproval === true;
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: awaitingLeaderApproval
            ? "teammate.awaiting-approval"
            : isTeamTask
              ? "teammate.progress"
              : "task.progress",
          summary: awaitingLeaderApproval
            ? "Leader approval requested"
            : isTeamTask
              ? `${teammateLabel} update`
              : "Reasoning update",
          payload: {
            taskId: event.payload.taskId,
            detail: truncateDetail(event.payload.summary ?? event.payload.description),
            ...(event.payload.summary ? { summary: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...metadata,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      const metadata = teamMetadataPayload(event.payload as Record<string, unknown>);
      const teammateLabel = teammateActivityLabel(event.payload as Record<string, unknown>);
      const isTeamTask = hasTeamMetadata(event.payload as Record<string, unknown>);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: isTeamTask
            ? event.payload.status === "failed"
              ? "teammate.failed"
              : event.payload.status === "stopped"
                ? "teammate.stopped"
                : "teammate.completed"
            : "task.completed",
          summary: isTeamTask
            ? event.payload.status === "failed"
              ? `${teammateLabel} failed`
              : event.payload.status === "stopped"
                ? `${teammateLabel} stopped`
                : `${teammateLabel} completed`
            : event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(event.payload.summary ? { detail: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...metadata,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "hook.started": {
      const metadata = teamMetadataPayload(event.payload as Record<string, unknown>);
      const hookEvent = event.payload.hookEvent;
      const isTeamHook = hasTeamMetadata(event.payload as Record<string, unknown>);
      const hookEventKind =
        isTeamHook && hookEvent === "SubagentStart"
          ? "teammate.started"
          : isTeamHook && hookEvent === "TeammateIdle"
            ? "teammate.idle"
            : isTeamHook && hookEvent === "TaskCompleted"
              ? "teammate.completed"
              : isTeamHook && hookEvent === "SubagentStop"
                ? "teammate.stopped"
                : "hook.started";
      const hookSummary =
        isTeamHook && hookEvent === "SubagentStart"
          ? "Teammate started"
          : isTeamHook && hookEvent === "TeammateIdle"
            ? "Teammate idle"
            : isTeamHook && hookEvent === "TaskCompleted"
              ? "Teammate completed"
              : isTeamHook && hookEvent === "SubagentStop"
                ? "Teammate stopped"
                : `Hook started: ${event.payload.hookEvent}`;
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: hookEventKind,
          summary: hookSummary,
          payload: {
            hookId: event.payload.hookId,
            hookName: event.payload.hookName,
            hookEvent,
            ...metadata,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      const metadata = teamMetadataPayload(event.payload as Record<string, unknown>);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
            ...metadata,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.completed": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      const metadata = teamMetadataPayload(event.payload as Record<string, unknown>);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: event.payload.title ?? "Tool",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...metadata,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.started": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      const metadata = teamMetadataPayload(event.payload as Record<string, unknown>);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...metadata,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  return [];
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;

  const assistantDeliveryModeRef = yield* Ref.make<AssistantDeliveryMode>(
    DEFAULT_ASSISTANT_DELIVERY_MODE,
  );

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  const bufferedReasoningById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_REASONING_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_REASONING_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  const isGitRepoForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return false;
    }
    const workspaceCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    if (!workspaceCwd) {
      return false;
    }
    return isGitRepository(workspaceCwd);
  });

  const readClaudeTeamArtifactSnapshot = (
    workspaceCwd: string | null,
    payload: Record<string, unknown>,
  ): Effect.Effect<TeamArtifactSnapshot | undefined> =>
    Effect.tryPromise({
      try: async () => {
        const roots = [workspaceCwd, homedir()]
          .filter((value): value is string => typeof value === "string" && value.length > 0)
          .flatMap((root) => [
            path.join(root, ".claude", "teams"),
            path.join(root, ".claude", "tasks"),
          ]);
        const seen = new Set<string>();
        const uniqueRoots = roots.filter((root) => {
          if (seen.has(root)) {
            return false;
          }
          seen.add(root);
          return true;
        });
        const teamName = asString(payload.teamName);
        const teammateName = asString(payload.teammateName) ?? asString(payload.agentName);
        const desiredTaskId = asString(payload.taskId);

        const jsonFiles: string[] = [];
        const visit = async (root: string, depth: number) => {
          if (depth > 3 || jsonFiles.length >= 64) {
            return;
          }
          let entries: Array<{
            readonly name: string;
            readonly isDirectory: () => boolean;
            readonly isFile: () => boolean;
          }>;
          try {
            entries = (await fs.readdir(root, {
              withFileTypes: true,
            })) as unknown as typeof entries;
          } catch {
            return;
          }
          for (const entry of entries) {
            if (jsonFiles.length >= 64) {
              break;
            }
            const absolutePath = path.join(root, entry.name);
            if (entry.isDirectory()) {
              await visit(absolutePath, depth + 1);
              continue;
            }
            if (entry.isFile() && entry.name.endsWith(".json")) {
              jsonFiles.push(absolutePath);
            }
          }
        };
        await Promise.all(uniqueRoots.map((root) => visit(root, 0)));

        const extractMembers = (record: Record<string, unknown>): TeamArtifactMember[] => {
          const leadAgentId =
            asString(record.leadAgentId) ??
            asString(record.lead_agent_id) ??
            asString(asRecord(record.team)?.leadAgentId) ??
            asString(asRecord(record.team)?.lead_agent_id);
          const candidates = [
            record.members,
            record.teammates,
            record.agents,
            asRecord(record.team)?.members,
          ];
          for (const candidate of candidates) {
            if (!Array.isArray(candidate)) {
              continue;
            }
            return candidate
              .map((entry) => asRecord(entry))
              .filter((entry): entry is Record<string, unknown> => entry !== undefined)
              .map((entry) => {
                const teammateRecord = asRecord(entry.teammate);
                const agentRecord = asRecord(entry.agent);
                const member: TeamArtifactMember = {};
                const agentId =
                  asString(entry.agentId) ??
                  asString(entry.agent_id) ??
                  asString(entry.teammateId) ??
                  asString(entry.teammate_id) ??
                  asString(entry.id) ??
                  asString(teammateRecord?.id) ??
                  asString(agentRecord?.id);
                const teammateName =
                  asString(entry.teammateName) ??
                  asString(entry.teammate_name) ??
                  asString(entry.displayName) ??
                  asString(entry.display_name) ??
                  asString(entry.label) ??
                  asString(entry.name) ??
                  asString(teammateRecord?.displayName) ??
                  asString(teammateRecord?.display_name) ??
                  asString(teammateRecord?.label) ??
                  asString(teammateRecord?.name);
                const agentName =
                  asString(entry.agentName) ??
                  asString(entry.agent_name) ??
                  asString(agentRecord?.displayName) ??
                  asString(agentRecord?.display_name) ??
                  asString(agentRecord?.label) ??
                  asString(agentRecord?.name);
                const agentColor = asString(entry.agentColor) ?? asString(entry.color);
                const agentType = asString(entry.agentType) ?? asString(entry.type);
                if (agentId) {
                  member.agentId = agentId;
                }
                if (teammateName) {
                  member.teammateName = teammateName;
                }
                if (agentName) {
                  member.agentName = agentName;
                }
                if (agentColor) {
                  member.agentColor = agentColor;
                }
                if (agentType) {
                  member.agentType = agentType;
                }
                return member;
              })
              .filter(
                (member) =>
                  (member.agentId !== undefined ||
                    member.teammateName !== undefined ||
                    member.agentName !== undefined ||
                    member.agentColor !== undefined ||
                    member.agentType !== undefined) &&
                  member.agentId !== leadAgentId &&
                  member.teammateName !== "team-lead" &&
                  member.agentName !== "team-lead",
              );
          }
          return [];
        };

        const normalizeArtifactTaskStatus = (value: unknown): string | undefined => {
          const normalized = asString(value)?.trim().toLowerCase();
          if (!normalized) {
            return undefined;
          }
          if (
            normalized === "in_progress" ||
            normalized === "in-progress" ||
            normalized === "running"
          ) {
            return "running";
          }
          if (normalized === "idle") {
            return "idle";
          }
          if (
            normalized === "pending_approval" ||
            normalized === "pending-approval" ||
            normalized === "awaiting_approval" ||
            normalized === "awaiting-approval"
          ) {
            return "awaitingApproval";
          }
          if (normalized === "completed" || normalized === "done") {
            return "completed";
          }
          if (normalized === "failed" || normalized === "error") {
            return "failed";
          }
          if (
            normalized === "stopped" ||
            normalized === "shutdown" ||
            normalized === "shut_down" ||
            normalized === "shut-down" ||
            normalized === "terminated"
          ) {
            return "stopped";
          }
          return normalized;
        };

        const extractTaskRecord = (record: Record<string, unknown>): TeamArtifactTask[] => {
          const looksLikeTeamConfig =
            Array.isArray(record.members) ||
            Array.isArray(asRecord(record.team)?.members) ||
            asString(record.leadAgentId) !== undefined ||
            asString(record.lead_agent_id) !== undefined;
          const directTaskId =
            asString(record.taskId) ?? asString(record.task_id) ?? asString(record.id);
          const directStatus = normalizeArtifactTaskStatus(record.status);
          const directSummary =
            asString(record.summary) ?? asString(record.description) ?? asString(record.title);
          const directTeammate =
            asString(record.teammateName) ??
            asString(record.subject) ??
            asString(record.assignee) ??
            asString(record.agentName) ??
            asString(record.name);
          const directUpdatedAt =
            asString(record.updatedAt) ??
            asString(record.completedAt) ??
            asString(record.endedAt) ??
            asString(record.startedAt);
          if (
            !looksLikeTeamConfig &&
            (directTaskId || directStatus || directSummary || directTeammate)
          ) {
            return [
              {
                ...(directTaskId ? { taskId: directTaskId } : {}),
                ...(directTeammate ? { teammateName: directTeammate } : {}),
                ...(directSummary ? { summary: directSummary } : {}),
                ...(directStatus ? { status: directStatus } : {}),
                ...(directUpdatedAt ? { updatedAt: directUpdatedAt } : {}),
              },
            ];
          }
          const nestedTaskLists = [record.tasks, record.items, record.history];
          for (const candidate of nestedTaskLists) {
            if (!Array.isArray(candidate)) {
              continue;
            }
            return candidate
              .map((entry) => asRecord(entry))
              .filter((entry): entry is Record<string, unknown> => entry !== undefined)
              .flatMap((entry) => extractTaskRecord(entry));
          }
          return [];
        };

        type ParsedArtifact = {
          readonly teamName?: string;
          readonly members: TeamArtifactMember[];
          readonly tasks: TeamArtifactTask[];
        };

        const parsedArtifacts: ParsedArtifact[] = [];
        for (const filePath of jsonFiles) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
          } catch {
            continue;
          }
          const record = asRecord(parsed);
          if (!record) {
            continue;
          }
          parsedArtifacts.push({
            teamName:
              asString(record.teamName) ??
              asString(record.team_name) ??
              asString(record.name) ??
              path.basename(path.dirname(filePath)),
            members: extractMembers(record),
            tasks: extractTaskRecord(record),
          });
        }

        const matchingArtifacts = parsedArtifacts.filter((artifact) => {
          if (teamName && artifact.teamName === teamName) {
            return true;
          }
          if (teammateName) {
            return (
              artifact.members.some(
                (member) =>
                  member.teammateName === teammateName || member.agentName === teammateName,
              ) || artifact.tasks.some((task) => task.teammateName === teammateName)
            );
          }
          if (desiredTaskId) {
            return artifact.tasks.some((task) => task.taskId === desiredTaskId);
          }
          return false;
        });

        if (matchingArtifacts.length === 0) {
          return undefined;
        }

        const selectedTeamName =
          teamName ??
          matchingArtifacts.find((artifact) => artifact.teamName !== undefined)?.teamName ??
          matchingArtifacts[0]?.teamName;
        const relatedArtifacts = selectedTeamName
          ? matchingArtifacts.filter((artifact) => artifact.teamName === selectedTeamName)
          : matchingArtifacts;
        if (relatedArtifacts.length === 0) {
          return undefined;
        }

        const membersByKey = new Map<string, TeamArtifactMember>();
        for (const artifact of relatedArtifacts) {
          for (const member of artifact.members) {
            const key =
              member.agentId ??
              member.teammateName ??
              member.agentName ??
              `member:${membersByKey.size + 1}`;
            const existing = membersByKey.get(key);
            membersByKey.set(key, {
              ...existing,
              ...member,
            });
          }
        }

        const tasksByKey = new Map<string, TeamArtifactTask>();
        for (const artifact of relatedArtifacts) {
          for (const task of artifact.tasks) {
            const key =
              task.taskId ?? task.teammateName ?? task.summary ?? `task:${tasksByKey.size + 1}`;
            const existing = tasksByKey.get(key);
            tasksByKey.set(key, {
              ...existing,
              ...task,
            });
          }
        }

        const members = [...membersByKey.values()];
        const tasks = [...tasksByKey.values()];
        const terminalStatuses = new Set(["completed", "failed", "stopped"]);
        const allTasksTerminal =
          tasks.length > 0 && tasks.every((task) => terminalStatuses.has(task.status ?? ""));
        const endedAt = allTasksTerminal
          ? tasks
              .map((task) => task.updatedAt)
              .filter((value): value is string => value !== undefined)
              .toSorted((left, right) => right.localeCompare(left))[0]
          : undefined;
        return {
          ...(selectedTeamName ? { teamName: selectedTeamName } : {}),
          members,
          tasks,
          ...(endedAt ? { endedAt } : {}),
          ...(allTasksTerminal ? { endedReason: "claude-file-status" } : {}),
        };
      },
      catch: (cause) =>
        new ClaudeArtifactSnapshotError({
          message: "Failed to read Claude team artifacts.",
          cause,
        }),
    }).pipe(Effect.catchTag("ClaudeArtifactSnapshotError", () => Effect.succeed(undefined)));

  const enrichTeamActivities = (input: {
    readonly thread: {
      readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
    };
    readonly workspaceCwd: string | null;
    readonly baseActivities: ReadonlyArray<OrchestrationThreadActivity>;
  }) =>
    Effect.forEach(
      input.baseActivities,
      (activity) =>
        Effect.gen(function* () {
          const payload = asRecord(activity.payload);
          const isSparseCollabAgentToolActivity =
            (activity.kind === "tool.started" ||
              activity.kind === "tool.updated" ||
              activity.kind === "tool.completed") &&
            asString(payload?.itemType) === "collab_agent_tool_call";
          if (!payload || (!hasTeamMetadata(payload) && !isSparseCollabAgentToolActivity)) {
            return [activity] as const;
          }

          const artifactSnapshot = hasTeamMetadata(payload)
            ? yield* readClaudeTeamArtifactSnapshot(input.workspaceCwd, payload)
            : undefined;
          const mergedPayload = teamPayloadFromArtifacts(payload, artifactSnapshot);
          const runInfo = currentTeamRunInfo(
            input.thread.activities,
            mergedPayload,
            activity.turnId,
            activity.createdAt,
          );
          if (!runInfo) {
            return [
              {
                ...activity,
                payload: {
                  ...mergedPayload,
                  statusSource: "runtime" satisfies TeamStatusSource,
                },
              },
            ] as const;
          }

          const enrichedActivity: OrchestrationThreadActivity = {
            ...activity,
            summary: teammateActivitySummary(activity.kind, mergedPayload, activity.summary),
            payload: {
              ...mergedPayload,
              runId: runInfo.runId,
              teamKey: runInfo.teamKey,
              statusSource: "runtime" satisfies TeamStatusSource,
            },
          };
          const label = asString(mergedPayload.teamName) ?? teammateActivityLabel(mergedPayload);
          const lifecycleActivities: OrchestrationThreadActivity[] = [];

          if (runInfo.isNew) {
            lifecycleActivities.push({
              id: EventId.makeUnsafe(`${activity.id}:team-run-started`),
              createdAt: activity.createdAt,
              tone: "info",
              kind: "team.run.started",
              summary: `${label} team started`,
              payload: {
                runId: runInfo.runId,
                teamKey: runInfo.teamKey,
                startedAt: runInfo.startedAt,
                statusSource: "runtime" satisfies TeamStatusSource,
                ...teamMetadataPayload(mergedPayload),
              },
              turnId: activity.turnId,
            });
          }

          lifecycleActivities.push({
            id: EventId.makeUnsafe(`${activity.id}:team-run-updated`),
            createdAt: activity.createdAt,
            tone: "info",
            kind: "team.run.updated",
            summary: `${label} team updated`,
            payload: {
              runId: runInfo.runId,
              teamKey: runInfo.teamKey,
              startedAt: runInfo.startedAt,
              statusSource: (artifactSnapshot
                ? "claude-files"
                : "runtime") satisfies TeamStatusSource,
              ...teamMetadataPayload(mergedPayload),
              ...(artifactSnapshot
                ? { members: artifactSnapshot.members, tasks: artifactSnapshot.tasks }
                : {}),
            },
            turnId: activity.turnId,
          });

          if (
            !runHasEnded(input.thread.activities, runInfo.runId) &&
            (teamRunShouldEnd(input.thread.activities, enrichedActivity, runInfo.runId) ||
              artifactSnapshot?.endedAt)
          ) {
            lifecycleActivities.push({
              id: EventId.makeUnsafe(`${activity.id}:team-run-ended`),
              createdAt: artifactSnapshot?.endedAt ?? activity.createdAt,
              tone: "info",
              kind: "team.run.ended",
              summary: `${label} team shut down`,
              payload: {
                runId: runInfo.runId,
                teamKey: runInfo.teamKey,
                startedAt: runInfo.startedAt,
                endedAt: artifactSnapshot?.endedAt ?? activity.createdAt,
                reason:
                  artifactSnapshot?.endedReason ??
                  (activity.kind === "teammate.stopped"
                    ? "teammate-stopped"
                    : "all-teammates-terminal"),
                statusSource: (artifactSnapshot?.endedAt
                  ? "claude-files"
                  : "runtime") satisfies TeamStatusSource,
                ...teamMetadataPayload(mergedPayload),
                ...(artifactSnapshot
                  ? { members: artifactSnapshot.members, tasks: artifactSnapshot.tasks }
                  : {}),
              },
              turnId: activity.turnId,
            });
          }

          return [
            ...(runInfo.isNew ? [lifecycleActivities[0]!] : []),
            enrichedActivity,
            ...lifecycleActivities.slice(runInfo.isNew ? 1 : 0),
          ] as const;
        }),
      { concurrency: 1 },
    ).pipe(Effect.map((groups) => groups.flat()));

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Effect.gen(function* () {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const takeBufferedProposedPlan = (planId: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedProposedPlanById, planId).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const appendBufferedReasoning = (activityId: EventId, delta: string, createdAt: string) =>
    Cache.getOption(bufferedReasoningById, activityId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedReasoningById, activityId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const upsertReasoningActivity = (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly activityId: EventId;
    readonly turnId?: TurnId;
    readonly streamKind: "reasoning_text" | "reasoning_summary_text";
    readonly updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const bufferedReasoning = yield* Cache.getOption(
        bufferedReasoningById,
        input.activityId,
      ).pipe(Effect.map(Option.getOrUndefined));
      const detail = bufferedReasoning?.text.trim();
      if (!detail) {
        return;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: providerCommandId(input.event, "reasoning-activity-upsert"),
        threadId: input.threadId,
        activity: {
          id: input.activityId,
          tone: "thinking",
          kind: "reasoning.trace",
          summary: "Thinking",
          payload: {
            detail,
            streamKind: input.streamKind,
          },
          turnId: input.turnId ?? null,
          createdAt: bufferedReasoning?.createdAt ?? input.updatedAt,
        },
        createdAt: input.updatedAt,
      });
    });

  const clearAssistantMessageState = (messageId: MessageId) =>
    clearBufferedAssistantText(messageId);

  const finalizeAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      const text =
        bufferedText.length > 0
          ? bufferedText
          : (input.fallbackText?.trim().length ?? 0) > 0
            ? input.fallbackText!
            : "";

      if (text.length > 0) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: providerCommandId(input.event, input.finalDeltaCommandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          delta: text,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: providerCommandId(input.event, input.commandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
      yield* clearAssistantMessageState(input.messageId);
    });

  const upsertProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
    }>;
    planId: string;
    turnId?: TurnId;
    planMarkdown: string | undefined;
    createdAt: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const planMarkdown = normalizeProposedPlanMarkdown(input.planMarkdown);
      if (!planMarkdown) {
        return;
      }

      const existingPlan = input.threadProposedPlans.find((entry) => entry.id === input.planId);
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: providerCommandId(input.event, "proposed-plan-upsert"),
        threadId: input.threadId,
        proposedPlan: {
          id: input.planId,
          turnId: input.turnId ?? null,
          planMarkdown,
          createdAt: existingPlan?.createdAt ?? input.createdAt,
          updatedAt: input.updatedAt,
        },
        createdAt: input.updatedAt,
      });
    });

  const finalizeBufferedProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
    }>;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const bufferedPlan = yield* takeBufferedProposedPlan(input.planId);
      const bufferedMarkdown = normalizeProposedPlanMarkdown(bufferedPlan?.text);
      const fallbackMarkdown = normalizeProposedPlanMarkdown(input.fallbackMarkdown);
      const planMarkdown = bufferedMarkdown ?? fallbackMarkdown;
      if (!planMarkdown) {
        return;
      }

      yield* upsertProposedPlan({
        event: input.event,
        threadId: input.threadId,
        threadProposedPlans: input.threadProposedPlans,
        planId: input.planId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        planMarkdown,
        createdAt:
          bufferedPlan?.createdAt && bufferedPlan.createdAt.length > 0
            ? bufferedPlan.createdAt
            : input.updatedAt,
        updatedAt: input.updatedAt,
      });
      yield* clearBufferedProposedPlan(input.planId);
    });

  const clearTurnStateForSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const prefix = `${threadId}:`;
      const proposedPlanPrefix = `plan:${threadId}:`;
      const reasoningPrefix = `thinking:${threadId}:`;
      const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
      const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
      const reasoningKeys = Array.from(yield* Cache.keys(bufferedReasoningById));
      yield* Effect.forEach(
        turnKeys,
        (key) =>
          Effect.gen(function* () {
            if (!key.startsWith(prefix)) {
              return;
            }

            const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
            if (Option.isSome(messageIds)) {
              yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
                concurrency: 1,
              }).pipe(Effect.asVoid);
            }

            yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        proposedPlanKeys,
        (key) =>
          key.startsWith(proposedPlanPrefix)
            ? Cache.invalidate(bufferedProposedPlanById, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        reasoningKeys,
        (key) =>
          key.startsWith(reasoningPrefix)
            ? Cache.invalidate(bufferedReasoningById, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    });

  const processRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === event.threadId);
      if (!thread) return;
      const workspaceCwd = resolveThreadWorkspaceCwd({
        thread,
        projects: readModel.projects,
      });

      const now = event.createdAt;
      const eventTurnId = toTurnId(event.turnId);
      const activeTurnId = thread.session?.activeTurnId ?? null;

      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;

      const shouldApplyThreadLifecycle = (() => {
        if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
          return true;
        }
        switch (event.type) {
          case "session.exited":
            return true;
          case "session.started":
          case "thread.started":
            return true;
          case "turn.started":
            return !conflictsWithActiveTurn;
          case "turn.completed":
            if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            // If no active turn is tracked, accept completion scoped to this thread.
            return true;
          default:
            return true;
        }
      })();

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed"
      ) {
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : event.type === "turn.completed" || event.type === "session.exited"
              ? null
              : activeTurnId;
        const status = (() => {
          switch (event.type) {
            case "session.state.changed":
              return orchestrationSessionStatusFromRuntimeState(event.payload.state);
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed":
              return runtimeTurnState(event) === "failed" ? "error" : "ready";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active turn; preserve turn-running state in that case.
              return activeTurnId !== null ? "running" : "ready";
          }
        })();
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" && runtimeTurnState(event) === "failed"
              ? (runtimeTurnErrorMessage(event) ?? thread.session?.lastError ?? "Turn failed")
              : status === "ready"
                ? null
                : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "thread-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: nextActiveTurnId,
              lastError,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      const assistantDelta =
        event.type === "content.delta" && event.payload.streamKind === "assistant_text"
          ? event.payload.delta
          : undefined;
      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      if (assistantDelta && assistantDelta.length > 0) {
        const assistantMessageId = MessageId.makeUnsafe(
          `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
        );
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        const assistantDeliveryMode = yield* Ref.get(assistantDeliveryModeRef);
        if (assistantDeliveryMode === "buffered") {
          const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);
          if (spillChunk.length > 0) {
            yield* orchestrationEngine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: providerCommandId(event, "assistant-delta-buffer-spill"),
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
            });
          }
        } else {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: providerCommandId(event, "assistant-delta"),
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: assistantDelta,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      }

      if (proposedPlanDelta && proposedPlanDelta.length > 0) {
        const planId = proposedPlanIdFromEvent(event, thread.id);
        yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
      }

      if (
        event.type === "content.delta" &&
        (event.payload.streamKind === "reasoning_text" ||
          event.payload.streamKind === "reasoning_summary_text") &&
        event.payload.delta.length > 0
      ) {
        const activityId = reasoningActivityIdFromEvent(event, thread.id);
        const reasoningTurnId = toTurnId(event.turnId);
        const reasoningStreamKind = event.payload.streamKind;
        yield* appendBufferedReasoning(activityId, event.payload.delta, now);
        yield* upsertReasoningActivity({
          event,
          threadId: thread.id,
          activityId,
          ...(reasoningTurnId ? { turnId: reasoningTurnId } : {}),
          streamKind: reasoningStreamKind,
          updatedAt: now,
        });
      }

      const assistantCompletion =
        event.type === "item.completed" && event.payload.itemType === "assistant_message"
          ? {
              messageId: MessageId.makeUnsafe(
                `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
              ),
              fallbackText: event.payload.detail,
            }
          : undefined;
      const proposedPlanCompletion =
        event.type === "turn.proposed.completed"
          ? {
              planId: proposedPlanIdFromEvent(event, thread.id),
              turnId: toTurnId(event.turnId),
              planMarkdown: event.payload.planMarkdown,
            }
          : undefined;

      if (assistantCompletion) {
        const assistantMessageId = assistantCompletion.messageId;
        const turnId = toTurnId(event.turnId);
        const existingAssistantMessage = thread.messages.find(
          (entry) => entry.id === assistantMessageId,
        );
        const shouldApplyFallbackCompletionText =
          !existingAssistantMessage || existingAssistantMessage.text.length === 0;
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        yield* finalizeAssistantMessage({
          event,
          threadId: thread.id,
          messageId: assistantMessageId,
          ...(turnId ? { turnId } : {}),
          createdAt: now,
          commandTag: "assistant-complete",
          finalDeltaCommandTag: "assistant-delta-finalize",
          ...(assistantCompletion.fallbackText !== undefined && shouldApplyFallbackCompletionText
            ? { fallbackText: assistantCompletion.fallbackText }
            : {}),
        });

        if (turnId) {
          yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
        }
      }

      if (proposedPlanCompletion) {
        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          threadProposedPlans: thread.proposedPlans,
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
      }

      if (event.type === "turn.completed") {
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
          yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              finalizeAssistantMessage({
                event,
                threadId: thread.id,
                messageId: assistantMessageId,
                turnId,
                createdAt: now,
                commandTag: "assistant-complete-finalize",
                finalDeltaCommandTag: "assistant-delta-finalize-fallback",
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          yield* clearAssistantMessageIdsForTurn(thread.id, turnId);

          yield* finalizeBufferedProposedPlan({
            event,
            threadId: thread.id,
            threadProposedPlans: thread.proposedPlans,
            planId: proposedPlanIdForTurn(thread.id, turnId),
            turnId,
            updatedAt: now,
          });
        }
      }

      if (event.type === "session.exited") {
        yield* clearTurnStateForSession(thread.id);
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage = runtimeErrorMessageFromEvent(event) ?? "Provider runtime error";

        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

        if (shouldApplyRuntimeError) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: eventTurnId ?? null,
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "thread.metadata.updated" && event.payload.name) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: providerCommandId(event, "thread-meta-update"),
          threadId: thread.id,
          title: event.payload.name,
        });
      }

      if (event.type === "turn.diff.updated") {
        const turnId = toTurnId(event.turnId);
        if (turnId && (yield* isGitRepoForThread(thread.id))) {
          // Skip if a checkpoint already exists for this turn. A real
          // (non-placeholder) capture from CheckpointReactor should not
          // be clobbered, and dispatching a duplicate placeholder for the
          // same turnId would produce an unstable checkpointTurnCount.
          if (thread.checkpoints.some((c) => c.turnId === turnId)) {
            // Already tracked; no-op.
          } else {
            const assistantMessageId = MessageId.makeUnsafe(
              `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
            );
            const maxTurnCount = thread.checkpoints.reduce(
              (max, c) => Math.max(max, c.checkpointTurnCount),
              0,
            );
            yield* orchestrationEngine.dispatch({
              type: "thread.turn.diff.complete",
              commandId: providerCommandId(event, "thread-turn-diff-complete"),
              threadId: thread.id,
              turnId,
              completedAt: now,
              checkpointRef: CheckpointRef.makeUnsafe(`provider-diff:${event.eventId}`),
              status: "missing",
              files: [],
              assistantMessageId,
              checkpointTurnCount: maxTurnCount + 1,
              createdAt: now,
            });
          }
        }
      }

      const activities = yield* enrichTeamActivities({
        thread,
        workspaceCwd: workspaceCwd ?? null,
        baseActivities: runtimeEventToActivities(event),
      });
      yield* Effect.forEach(activities, (activity) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: providerCommandId(event, "thread-activity-append"),
          threadId: thread.id,
          activity,
          createdAt: activity.createdAt,
        }),
      ).pipe(Effect.asVoid);
    });

  const processDomainEvent = (event: TurnStartRequestedDomainEvent) =>
    Ref.set(
      assistantDeliveryModeRef,
      event.payload.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
    );

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime" ? processRuntimeEvent(input.event) : processDomainEvent(input.event);

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          eventId: input.event.eventId,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: ProviderRuntimeIngestionShape["start"] = Effect.gen(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        worker.enqueue({ source: "runtime", event }),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.turn-start-requested") {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(ProviderRuntimeIngestionService, make);
