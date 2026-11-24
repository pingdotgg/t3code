import {
  APPLE_INTENTS_MAX_INDEXED_THREADS,
  APPLE_INTENTS_MAX_MESSAGE_PREVIEW_CHARS,
  type AppleIntentEnvironmentRecord,
  type AppleIntentIndexDelta,
  type AppleIntentProjectRecord,
  type AppleIntentThreadRecord,
  type AppleIntentThreadStatus,
  type EnvironmentId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  isListedThreadLineage,
  isLiveSubagentShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export interface AppleIntentsProjectionEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string | null;
  readonly isLocal: boolean;
  readonly isConnected: boolean;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
}

export interface AppleIntentsProjectionOptions {
  readonly indexMessagePreviews: boolean;
  readonly nowMs: number;
  readonly maxThreads?: number;
  readonly resolve?: MFunctionType;
}

export interface AppleIntentsSnapshot {
  readonly environments: ReadonlyArray<AppleIntentEnvironmentRecord>;
  readonly projects: ReadonlyArray<AppleIntentProjectRecord>;
  readonly threads: ReadonlyArray<AppleIntentThreadRecord>;
}

// Strip ANSI escapes, collapse whitespace, and redact common secret-like token shapes before Spotlight indexing.
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;
const CODE_FENCE_PATTERN = /```[\s\S]*?```/g;
const SECRET_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})\b/g;
const BEARER_PATTERN = /\b(Bearer|DPoP)\s+[A-Za-z0-9._~+/=-]{16,}\b/gi;

export function sanitizeAppleIntentPreview(
  raw: string | null | undefined,
  maxChars = APPLE_INTENTS_MAX_MESSAGE_PREVIEW_CHARS,
): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CODE_FENCE_PATTERN, " [code] ")
    .replace(SECRET_TOKEN_PATTERN, "[redacted]")
    .replace(BEARER_PATTERN, "$1 [redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return null;
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export function buildAppleIntentThreadDeepLink(
  environmentId: EnvironmentId,
  threadId: string,
): string {
  return `t3code://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

function buildAppleIntentProjectDeepLink(
  environmentId: EnvironmentId,
  projectId: string,
  repositoryIdentity: string | null,
): string {
  const params = new URLSearchParams();
  params.set("environmentId", environmentId);
  params.set("projectId", projectId);
  if (repositoryIdentity) {
    params.set("repo", repositoryIdentity);
  }
  return `t3code://new?${params.toString()}`;
}

function normalizeAppleIntentThreadStatus(
  thread: Pick<
    OrchestrationV2ThreadShell,
    "status" | "activityRunStatus" | "pendingRuntimeRequest" | "lastError"
  >,
): AppleIntentThreadStatus {
  if (thread.pendingRuntimeRequest !== null) return "waiting";
  const effective = thread.activityRunStatus ?? thread.status;
  switch (effective) {
    case "running":
    case "starting":
    case "preparing":
      return "running";
    case "waiting":
      return "waiting";
    case "queued":
      return "queued";
    case "failed":
      return "error";
    default:
      return thread.lastError ? "error" : "idle";
  }
}

function formatPendingRequestSummary(
  request: OrchestrationV2ThreadShell["pendingRuntimeRequest"],
  resolve: MFunctionType,
): string | null {
  if (request === null) return null;
  switch (request.kind) {
    case "command":
      return resolve(msg("Command approval required"));
    case "file-read":
      return resolve(msg("File read approval required"));
    case "file-change":
      return resolve(msg("File edit approval required"));
    case "user_input":
      return resolve(msg("Waiting for your answer"));
    case "permission":
      return resolve(msg("Permission approval required"));
    case "mcp-elicitation":
    case "dynamic_tool_call":
      return resolve(msg("Tool input required"));
    case "auth_refresh":
      return resolve(msg("Authentication required"));
  }
}

function toIsoString(value: DateTime.DateTime | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : DateTime.formatIso(value);
}

function toEpochMillis(value: DateTime.DateTime | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return DateTime.toEpochMillis(value);
}

function threadPriorityScore(record: AppleIntentThreadRecord): number {
  if (record.hasPendingRequest) return 4;
  if (record.status === "running" || record.status === "waiting" || record.status === "queued") {
    return 3;
  }
  if (record.isPinned) return 2;
  if (!record.isSettled && !record.isSnoozed) return 1;
  return 0;
}

export function buildAppleIntentsSnapshot(
  inputs: ReadonlyArray<AppleIntentsProjectionEnvironmentInput>,
  options: AppleIntentsProjectionOptions,
): AppleIntentsSnapshot {
  const nowMs = options.nowMs;
  const maxThreads = Math.max(0, options.maxThreads ?? APPLE_INTENTS_MAX_INDEXED_THREADS);
  const resolve = options.resolve ?? mFallback;

  const environments: AppleIntentEnvironmentRecord[] = [];
  const projects: AppleIntentProjectRecord[] = [];
  const candidateThreads: Array<{
    readonly record: AppleIntentThreadRecord;
    readonly updatedAtMs: number;
  }> = [];

  for (const env of inputs) {
    let latestEnvUpdatedMs = 0;
    const projectNameById = new Map<string, string>();
    const projectRepoById = new Map<string, string | null>();
    const projectBranchById = new Map<string, string | null>();

    for (const thread of env.threads) {
      if (thread.deletedAt !== null || thread.archivedAt !== null) continue;
      if (thread.branch && !projectBranchById.has(thread.projectId)) {
        projectBranchById.set(thread.projectId, thread.branch);
      }
    }

    for (const project of env.projects) {
      if (project.archivedAt !== null && project.archivedAt !== undefined) continue;
      const projectUpdatedMs = toEpochMillis(project.updatedAt);
      if (projectUpdatedMs > latestEnvUpdatedMs) latestEnvUpdatedMs = projectUpdatedMs;
      const repoId = project.repositoryIdentity?.canonicalKey ?? null;
      projectNameById.set(project.id, project.title);
      projectRepoById.set(project.id, repoId);
      projects.push({
        id: `${env.environmentId}:${project.id}`,
        environmentId: env.environmentId,
        projectId: project.id,
        name: project.title,
        workspaceRoot: project.workspaceRoot,
        repositoryIdentity: repoId,
        branch: projectBranchById.get(project.id) ?? null,
        updatedAt: project.updatedAt,
        deepLinkUrl: buildAppleIntentProjectDeepLink(env.environmentId, project.id, repoId),
      });
    }

    for (const thread of env.threads) {
      if (thread.deletedAt !== null || thread.archivedAt !== null) continue;
      const listed = isListedThreadLineage(thread.lineage);
      if (!listed) {
        // Keep only subagents actively blocking on user approval; omit quiet subagents and side chats.
        const blockingSubagent =
          thread.lineage.relationshipToParent === "subagent" &&
          isLiveSubagentShell(thread) &&
          thread.pendingRuntimeRequest !== null;
        if (!blockingSubagent) continue;
      }

      const updatedAtMs = toEpochMillis(thread.updatedAt);
      if (updatedAtMs > latestEnvUpdatedMs) latestEnvUpdatedMs = updatedAtMs;

      const snoozedUntilIso = toIsoString(thread.snoozedUntil);
      const snoozedUntilMs = toEpochMillis(thread.snoozedUntil);
      const isSnoozed = snoozedUntilMs > nowMs;
      const isSettled = thread.settledOverride === "settled" || thread.settledAt !== null;
      const isPinned = thread.pinnedAt !== null && thread.pinnedAt !== undefined;
      const title = thread.title.trim() || resolve(msg("Untitled Thread"));
      const projectName = projectNameById.get(thread.projectId) ?? resolve(msg("Project"));

      candidateThreads.push({
        updatedAtMs,
        record: {
          id: `${env.environmentId}:${thread.id}`,
          environmentId: env.environmentId,
          threadId: thread.id,
          projectId: thread.projectId,
          projectName,
          title,
          branch: thread.branch,
          status: normalizeAppleIntentThreadStatus(thread),
          hasPendingRequest: thread.pendingRuntimeRequest !== null,
          pendingRequestSummary: formatPendingRequestSummary(thread.pendingRuntimeRequest, resolve),
          isPinned,
          isSettled,
          isSnoozed,
          snoozedUntil: isSnoozed ? snoozedUntilIso : null,
          lastMessagePreview: options.indexMessagePreviews
            ? sanitizeAppleIntentPreview(thread.latestVisibleMessage?.text)
            : null,
          providerLabel: thread.providerInstanceId,
          modelLabel: thread.modelSelection.model,
          updatedAt: DateTime.formatIso(thread.updatedAt),
          deepLinkUrl: buildAppleIntentThreadDeepLink(env.environmentId, thread.id),
        },
      });
    }

    environments.push({
      id: env.environmentId,
      label: env.label,
      httpBaseUrl: env.httpBaseUrl,
      isLocal: env.isLocal,
      isConnected: env.isConnected,
      updatedAt: DateTime.formatIso(
        DateTime.makeUnsafe(latestEnvUpdatedMs > 0 ? latestEnvUpdatedMs : nowMs),
      ),
    });
  }

  candidateThreads.sort((left, right) => {
    const priorityDiff = threadPriorityScore(right.record) - threadPriorityScore(left.record);
    if (priorityDiff !== 0) return priorityDiff;
    if (right.updatedAtMs !== left.updatedAtMs) return right.updatedAtMs - left.updatedAtMs;
    return left.record.id.localeCompare(right.record.id);
  });

  environments.sort((a, b) => a.id.localeCompare(b.id));
  projects.sort((a, b) => a.id.localeCompare(b.id));

  return {
    environments,
    projects,
    threads: candidateThreads.slice(0, maxThreads).map((entry) => entry.record),
  };
}

function stableRecordSignature(value: unknown): string {
  return JSON.stringify(value);
}

export interface AppleIntentsDiffResult {
  readonly hasChanges: boolean;
  readonly delta: AppleIntentIndexDelta;
}

/**
 * With no previous snapshot (the first sync of a launch), the delta replaces the native index:
 * records it retained from earlier launches that are no longer present are removed.
 */
export function diffAppleIntentsSnapshots(
  previous: AppleIntentsSnapshot | null,
  next: AppleIntentsSnapshot,
): AppleIntentsDiffResult {
  if (previous === null) {
    return {
      hasChanges: true,
      delta: {
        environments: [...next.environments],
        removedEnvironmentIds: [],
        upsertedProjects: [...next.projects],
        removedProjectIds: [],
        upsertedThreads: [...next.threads],
        removedThreadIds: [],
        replaceAll: true,
      },
    };
  }
  const prevEnvMap = new Map(previous.environments.map((item) => [item.id, item]));
  const nextEnvIds = new Set(next.environments.map((item) => item.id));
  const environments: AppleIntentEnvironmentRecord[] = [];
  for (const env of next.environments) {
    const prev = prevEnvMap.get(env.id);
    if (!prev || stableRecordSignature(prev) !== stableRecordSignature(env)) {
      environments.push(env);
    }
  }
  const removedEnvironmentIds: EnvironmentId[] = [];
  for (const prevId of prevEnvMap.keys()) {
    if (!nextEnvIds.has(prevId)) removedEnvironmentIds.push(prevId);
  }

  const prevProjectMap = new Map(previous.projects.map((item) => [item.id, item]));
  const nextProjectIds = new Set(next.projects.map((item) => item.id));
  const upsertedProjects: AppleIntentProjectRecord[] = [];
  for (const project of next.projects) {
    const prev = prevProjectMap.get(project.id);
    if (!prev || stableRecordSignature(prev) !== stableRecordSignature(project)) {
      upsertedProjects.push(project);
    }
  }
  const removedProjectIds: string[] = [];
  for (const prevId of prevProjectMap.keys()) {
    if (!nextProjectIds.has(prevId)) removedProjectIds.push(prevId);
  }

  const prevThreadMap = new Map(previous.threads.map((item) => [item.id, item]));
  const nextThreadIds = new Set(next.threads.map((item) => item.id));
  const upsertedThreads: AppleIntentThreadRecord[] = [];
  for (const thread of next.threads) {
    const prev = prevThreadMap.get(thread.id);
    if (!prev || stableRecordSignature(prev) !== stableRecordSignature(thread)) {
      upsertedThreads.push(thread);
    }
  }
  const removedThreadIds: string[] = [];
  for (const prevId of prevThreadMap.keys()) {
    if (!nextThreadIds.has(prevId)) removedThreadIds.push(prevId);
  }

  const hasChanges =
    environments.length > 0 ||
    removedEnvironmentIds.length > 0 ||
    upsertedProjects.length > 0 ||
    removedProjectIds.length > 0 ||
    upsertedThreads.length > 0 ||
    removedThreadIds.length > 0;

  return {
    hasChanges,
    delta: {
      environments,
      removedEnvironmentIds,
      upsertedProjects,
      removedProjectIds,
      upsertedThreads,
      removedThreadIds,
    },
  };
}
