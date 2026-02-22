import type {
  OrchestrationEvent,
  OrchestrationGitReadModel,
  OrchestrationMessage,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationSession,
  OrchestrationThread,
} from "@t3tools/contracts";

type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "projectId">>;

function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: string,
  patch: ThreadPatch,
): OrchestrationThread[] {
  return threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread));
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return {
    sequence: 0,
    projects: [],
    threads: [],
    gitByProjectId: {},
    updatedAt: nowIso,
  };
}

export function reduceEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): OrchestrationReadModel {
  const payload = asObject(event.payload);
  const nextBase: OrchestrationReadModel = {
    ...model,
    sequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "project.created": {
      if (!payload) return nextBase;
      const project: OrchestrationProject = {
        id: asString(payload.id) ?? event.aggregateId,
        name: asString(payload.name) ?? "project",
        cwd: asString(payload.cwd) ?? "",
        model: asString(payload.model) ?? "gpt-5-codex",
        createdAt: asString(payload.createdAt) ?? event.occurredAt,
        updatedAt: asString(payload.updatedAt) ?? event.occurredAt,
      };
      const existing = nextBase.projects.find((entry) => entry.id === project.id);
      return {
        ...nextBase,
        projects: existing
          ? nextBase.projects.map((entry) => (entry.id === project.id ? project : entry))
          : [...nextBase.projects, project],
      };
    }
    case "project.deleted":
      return {
        ...nextBase,
        projects: nextBase.projects.filter((project) => project.id !== event.aggregateId),
        threads: nextBase.threads.filter((thread) => thread.projectId !== event.aggregateId),
      };
    case "thread.created": {
      if (!payload) return nextBase;
      const thread: OrchestrationThread = {
        id: asString(payload.id) ?? event.aggregateId,
        projectId: asString(payload.projectId) ?? "",
        title: asString(payload.title) ?? "New thread",
        model: asString(payload.model) ?? "gpt-5-codex",
        branch: asString(payload.branch),
        worktreePath: asString(payload.worktreePath),
        createdAt: asString(payload.createdAt) ?? event.occurredAt,
        updatedAt: asString(payload.updatedAt) ?? event.occurredAt,
        latestTurnId: null,
        latestTurnStartedAt: null,
        latestTurnCompletedAt: null,
        latestTurnDurationMs: null,
        messages: [],
        session: null,
        turnDiffSummaries: [],
        error: null,
      };
      const existing = nextBase.threads.find((entry) => entry.id === thread.id);
      return {
        ...nextBase,
        threads: existing
          ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
          : [...nextBase.threads, thread],
      };
    }
    case "thread.deleted":
      return {
        ...nextBase,
        threads: nextBase.threads.filter((thread) => thread.id !== event.aggregateId),
      };
    case "thread.meta-updated": {
      if (!payload) return nextBase;
      const threadId = asString(payload.threadId) ?? event.aggregateId;
      const thread = nextBase.threads.find((entry) => entry.id === threadId);
      if (!thread) return nextBase;
      return {
        ...nextBase,
        threads: updateThread(nextBase.threads, threadId, {
          ...(asString(payload.title) !== null ? { title: asString(payload.title) ?? thread.title } : {}),
          ...(asString(payload.model) !== null ? { model: asString(payload.model) ?? thread.model } : {}),
          ...(payload.branch !== undefined ? { branch: asString(payload.branch) } : {}),
          ...(payload.worktreePath !== undefined ? { worktreePath: asString(payload.worktreePath) } : {}),
          updatedAt: asString(payload.updatedAt) ?? event.occurredAt,
        }),
      };
    }
    case "message.sent": {
      if (!payload) return nextBase;
      const threadId = asString(payload.threadId) ?? event.aggregateId;
      const message: OrchestrationMessage = {
        id: asString(payload.id) ?? crypto.randomUUID(),
        role: (asString(payload.role) as OrchestrationMessage["role"] | null) ?? "user",
        text: asString(payload.text) ?? "",
        createdAt: asString(payload.createdAt) ?? event.occurredAt,
        streaming: payload.streaming === true,
      };
      const targetThread = nextBase.threads.find((thread) => thread.id === threadId);
      if (!targetThread) return nextBase;
      const existingMessage = targetThread.messages.find((entry) => entry.id === message.id);
      const nextMessages = existingMessage
        ? targetThread.messages.map((entry) =>
            entry.id === message.id
              ? {
                  ...entry,
                  text:
                    message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                  streaming: message.streaming,
                  createdAt: message.createdAt,
                }
              : entry,
          )
        : [...targetThread.messages, message];
      return {
        ...nextBase,
        threads: updateThread(nextBase.threads, threadId, {
          messages: nextMessages,
          updatedAt: event.occurredAt,
        }),
      };
    }
    case "thread.session-set": {
      if (!payload) return nextBase;
      const threadId = asString(payload.threadId) ?? event.aggregateId;
      const thread = nextBase.threads.find((entry) => entry.id === threadId);
      if (!thread) return nextBase;
      const sessionPayload = asObject(payload.session);
      if (!sessionPayload) return nextBase;
      const session: OrchestrationSession = {
        sessionId: asString(sessionPayload.sessionId) ?? crypto.randomUUID(),
        status:
          (asString(sessionPayload.status) as OrchestrationSession["status"] | null) ?? "connecting",
        provider:
          (asString(sessionPayload.provider) as OrchestrationSession["provider"] | null) ?? "codex",
        threadId,
        activeTurnId: asString(sessionPayload.activeTurnId),
        createdAt: asString(sessionPayload.createdAt) ?? event.occurredAt,
        updatedAt: asString(sessionPayload.updatedAt) ?? event.occurredAt,
        lastError: asString(sessionPayload.lastError),
      };
      return {
        ...nextBase,
        threads: updateThread(nextBase.threads, threadId, {
          session,
          updatedAt: event.occurredAt,
          error: session.lastError,
        }),
      };
    }
    case "thread.turn-diff-completed": {
      if (!payload) return nextBase;
      const threadId = asString(payload.threadId) ?? event.aggregateId;
      const thread = nextBase.threads.find((entry) => entry.id === threadId);
      const turnId = asString(payload.turnId);
      if (!thread || !turnId) return nextBase;

      const files = asArray(payload.files).flatMap((filePayload) => {
        const file = asObject(filePayload);
        const filePath = asString(file?.path);
        if (!filePath) {
          return [];
        }

        const nextFile: {
          path: string;
          kind?: string;
          additions?: number;
          deletions?: number;
        } = { path: filePath };
        const kind = asString(file?.kind);
        if (kind !== null) {
          nextFile.kind = kind;
        }
        const additions = asNumber(file?.additions);
        if (additions !== null) {
          nextFile.additions = additions;
        }
        const deletions = asNumber(file?.deletions);
        if (deletions !== null) {
          nextFile.deletions = deletions;
        }
        return [nextFile];
      });

      const nextSummary = {
        turnId,
        completedAt: asString(payload.completedAt) ?? event.occurredAt,
        ...(asString(payload.status) !== null ? { status: asString(payload.status) ?? undefined } : {}),
        files,
        ...(asString(payload.assistantMessageId) !== null
          ? { assistantMessageId: asString(payload.assistantMessageId) ?? undefined }
          : {}),
        ...(asNumber(payload.checkpointTurnCount) !== null
          ? { checkpointTurnCount: asNumber(payload.checkpointTurnCount) ?? undefined }
          : {}),
      };
      const turnDiffSummaries = [...thread.turnDiffSummaries.filter((summary) => summary.turnId !== turnId), nextSummary]
        .toSorted((left, right) => left.completedAt.localeCompare(right.completedAt));

      return {
        ...nextBase,
        threads: updateThread(nextBase.threads, threadId, {
          latestTurnId: turnId,
          latestTurnCompletedAt: nextSummary.completedAt,
          turnDiffSummaries,
          updatedAt: event.occurredAt,
        }),
      };
    }
    case "thread.reverted": {
      if (!payload) return nextBase;
      const threadId = asString(payload.threadId) ?? event.aggregateId;
      const thread = nextBase.threads.find((entry) => entry.id === threadId);
      if (!thread) return nextBase;

      const targetTurnCount = Math.max(0, Math.floor(asNumber(payload.turnCount) ?? 0));
      const targetMessageCount = Math.max(0, Math.floor(asNumber(payload.messageCount) ?? 0));
      const sortedSummaries = [...thread.turnDiffSummaries].toSorted((left, right) =>
        left.completedAt.localeCompare(right.completedAt),
      );
      const inferredTurnCountByTurnId = new Map<string, number>();
      for (let index = 0; index < sortedSummaries.length; index += 1) {
        const summary = sortedSummaries[index];
        if (!summary) continue;
        inferredTurnCountByTurnId.set(summary.turnId, index + 1);
      }

      const turnDiffSummaries = thread.turnDiffSummaries
        .filter((summary) => {
          const checkpointTurnCount =
            summary.checkpointTurnCount ?? inferredTurnCountByTurnId.get(summary.turnId) ?? 0;
          return checkpointTurnCount <= targetTurnCount;
        })
        .toSorted((left, right) => left.completedAt.localeCompare(right.completedAt));
      const latestSummary =
        turnDiffSummaries.length > 0 ? turnDiffSummaries[turnDiffSummaries.length - 1] : null;

      return {
        ...nextBase,
        threads: updateThread(nextBase.threads, threadId, {
          messages: thread.messages.slice(0, Math.min(targetMessageCount, thread.messages.length)),
          turnDiffSummaries,
          latestTurnId: latestSummary?.turnId ?? null,
          latestTurnStartedAt: null,
          latestTurnCompletedAt: latestSummary?.completedAt ?? null,
          latestTurnDurationMs: null,
          updatedAt: event.occurredAt,
        }),
      };
    }
    case "git.read-model-upsert": {
      if (!payload) return nextBase;
      const projectId = asString(payload.projectId) ?? event.aggregateId;
      const gitReadModel: OrchestrationGitReadModel = {
        projectId,
        branch: asString(payload.branch),
        hasWorkingTreeChanges: payload.hasWorkingTreeChanges === true,
        aheadCount: asNumber(payload.aheadCount) ?? 0,
        behindCount: asNumber(payload.behindCount) ?? 0,
        updatedAt: asString(payload.updatedAt) ?? event.occurredAt,
      };
      return {
        ...nextBase,
        gitByProjectId: {
          ...nextBase.gitByProjectId,
          [projectId]: gitReadModel,
        },
      };
    }
    default:
      return nextBase;
  }
}
