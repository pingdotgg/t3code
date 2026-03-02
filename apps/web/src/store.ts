import { Fragment, type ReactNode, createElement, useEffect } from "react";
import {
  DEFAULT_MODEL,
  ProviderSessionId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSessionStatus,
  resolveModelSlug,
} from "@t3tools/contracts";
import { create } from "zustand";
import {
  DEFAULT_RUNTIME_MODE,
  type ChatMessage,
  type Project,
  type RuntimeMode,
  type Thread,
} from "./types";

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  threadsHydrated: boolean;
  runtimeMode: RuntimeMode;
}

interface AppStore extends AppState {
  syncServerReadModel: (readModel: OrchestrationReadModel) => void;
  markThreadVisited: (threadId: ThreadId, visitedAt?: string) => void;
  markThreadUnread: (threadId: ThreadId) => void;
  toggleProject: (projectId: Project["id"]) => void;
  setThreadTerminalActivity: (
    threadId: ThreadId,
    terminalId: string,
    hasRunningSubprocess: boolean,
  ) => void;
  setProjectExpanded: (projectId: Project["id"], expanded: boolean) => void;
  toggleThreadTerminal: (threadId: ThreadId) => void;
  setThreadTerminalOpen: (threadId: ThreadId, open: boolean) => void;
  setThreadTerminalHeight: (threadId: ThreadId, height: number) => void;
  splitThreadTerminal: (threadId: ThreadId, terminalId: string) => void;
  newThreadTerminal: (threadId: ThreadId, terminalId: string) => void;
  setThreadActiveTerminal: (threadId: ThreadId, terminalId: string) => void;
  closeThreadTerminal: (threadId: ThreadId, terminalId: string) => void;
  setThreadError: (threadId: ThreadId, error: string | null) => void;
  setThreadBranch: (threadId: ThreadId, branch: string | null, worktreePath: string | null) => void;
  setRuntimeMode: (mode: RuntimeMode) => void;
}

const PERSISTED_STATE_KEY = "t3code:renderer-state:v7";
const LEGACY_PERSISTED_STATE_KEYS = [
  "t3code:renderer-state:v6",
  "t3code:renderer-state:v5",
  "t3code:renderer-state:v4",
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

const initialState: AppState = {
  projects: [],
  threads: [],
  threadsHydrated: false,
  runtimeMode: DEFAULT_RUNTIME_MODE,
};
const persistedExpandedProjectCwds = new Set<string>();

// ── Persist helpers ──────────────────────────────────────────────────

function readPersistedState(): AppState {
  if (typeof window === "undefined") return initialState;
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) return initialState;
    const parsed = JSON.parse(raw) as {
      runtimeMode?: RuntimeMode;
      expandedProjectCwds?: string[];
    };
    persistedExpandedProjectCwds.clear();
    for (const cwd of parsed.expandedProjectCwds ?? []) {
      if (typeof cwd === "string" && cwd.length > 0) {
        persistedExpandedProjectCwds.add(cwd);
      }
    }
    return {
      ...initialState,
      runtimeMode:
        parsed.runtimeMode === "approval-required" || parsed.runtimeMode === "full-access"
          ? parsed.runtimeMode
          : DEFAULT_RUNTIME_MODE,
    };
  } catch {
    return initialState;
  }
}

function persistState(state: AppState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        runtimeMode: state.runtimeMode,
        expandedProjectCwds: state.projects
          .filter((project) => project.expanded)
          .map((project) => project.cwd),
      }),
    );
    for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
      window.localStorage.removeItem(legacyKey);
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────

function updateThread(
  threads: Thread[],
  threadId: ThreadId,
  updater: (t: Thread) => Thread,
): Thread[] {
  return threads.map((t) => (t.id === threadId ? updater(t) : t));
}

function mapProjectsFromReadModel(
  incoming: OrchestrationReadModel["projects"],
  previous: Project[],
): Project[] {
  return incoming.map((project) => {
    const existing =
      previous.find((entry) => entry.id === project.id) ??
      previous.find((entry) => entry.cwd === project.workspaceRoot);
    return {
      id: project.id,
      name: project.title,
      cwd: project.workspaceRoot,
      model: existing?.model ?? resolveModelSlug(project.defaultModel ?? DEFAULT_MODEL),
      expanded:
        existing?.expanded ??
        (persistedExpandedProjectCwds.size > 0
          ? persistedExpandedProjectCwds.has(project.workspaceRoot)
          : true),
      scripts: project.scripts.map((script) => ({ ...script })),
    };
  });
}

function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

function toLegacyProvider(providerName: string | null): "codex" | "claudeCode" {
  return providerName === "claudeCode" ? "claudeCode" : "codex";
}

function resolveWsHttpOrigin(): string {
  if (typeof window === "undefined") return "";
  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;
  if (!wsCandidate) return window.location.origin;
  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:"
        ? "https:"
        : wsUrl.protocol === "ws:"
          ? "http:"
          : wsUrl.protocol;
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return window.location.origin;
  }
}

function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/")) {
    return `${resolveWsHttpOrigin()}${rawUrl}`;
  }
  return rawUrl;
}

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

// ── Pure state transition functions ────────────────────────────────────

export function syncServerReadModel(
  state: AppState,
  readModel: OrchestrationReadModel,
): AppState {
  const projects = mapProjectsFromReadModel(
    readModel.projects.filter((project) => project.deletedAt === null),
    state.projects,
  );
  const existingThreadById = new Map(
    state.threads.map((thread) => [thread.id, thread] as const),
  );
  const threads = readModel.threads
    .filter((thread) => thread.deletedAt === null)
    .map((thread) => {
      const existing = existingThreadById.get(thread.id);
      return {
        id: thread.id,
        codexThreadId: thread.session?.providerThreadId ?? null,
        projectId: thread.projectId,
        title: thread.title,
        model: resolveModelSlug(thread.model),
        session: thread.session
          ? {
              sessionId:
                thread.session.providerSessionId ??
                ProviderSessionId.makeUnsafe(`thread:${thread.id}`),
              provider: toLegacyProvider(thread.session.providerName),
              status: toLegacySessionStatus(thread.session.status),
              orchestrationStatus: thread.session.status,
              threadId: thread.session.providerThreadId,
              activeTurnId: thread.session.activeTurnId ?? undefined,
              createdAt: thread.session.updatedAt,
              updatedAt: thread.session.updatedAt,
              ...(thread.session.lastError ? { lastError: thread.session.lastError } : {}),
            }
          : null,
        messages: thread.messages.map((message) => {
          const attachments = message.attachments?.map((attachment) => ({
            type: "image" as const,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            previewUrl: toAttachmentPreviewUrl(attachmentPreviewRoutePath(attachment.id)),
          }));
          const normalizedMessage: ChatMessage = {
            id: message.id,
            role: message.role,
            text: message.text,
            createdAt: message.createdAt,
            streaming: message.streaming,
            ...(message.streaming ? {} : { completedAt: message.updatedAt }),
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
          };
          return normalizedMessage;
        }),
        error: thread.session?.lastError ?? null,
        createdAt: thread.createdAt,
        latestTurn: thread.latestTurn,
        lastVisitedAt: existing?.lastVisitedAt ?? thread.updatedAt,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        turnDiffSummaries: thread.checkpoints.map((checkpoint) => ({
          turnId: checkpoint.turnId,
          completedAt: checkpoint.completedAt,
          status: checkpoint.status,
          assistantMessageId: checkpoint.assistantMessageId ?? undefined,
          checkpointTurnCount: checkpoint.checkpointTurnCount,
          checkpointRef: checkpoint.checkpointRef,
          files: checkpoint.files.map((file) => ({ ...file })),
        })),
        activities: thread.activities.map((activity) => ({ ...activity })),
      };
    });
  return {
    ...state,
    projects,
    threads,
    threadsHydrated: true,
  };
}

export function markThreadVisited(
  state: AppState,
  threadId: ThreadId,
  visitedAt?: string,
): AppState {
  const at = visitedAt ?? new Date().toISOString();
  const visitedAtMs = Date.parse(at);
  return {
    ...state,
    threads: updateThread(state.threads, threadId, (thread) => {
      const previousVisitedAtMs = thread.lastVisitedAt ? Date.parse(thread.lastVisitedAt) : NaN;
      if (
        Number.isFinite(previousVisitedAtMs) &&
        Number.isFinite(visitedAtMs) &&
        previousVisitedAtMs >= visitedAtMs
      ) {
        return thread;
      }
      return { ...thread, lastVisitedAt: at };
    }),
  };
}

export function markThreadUnread(state: AppState, threadId: ThreadId): AppState {
  return {
    ...state,
    threads: updateThread(state.threads, threadId, (thread) => {
      if (!thread.latestTurn?.completedAt) return thread;
      const latestTurnCompletedAtMs = Date.parse(thread.latestTurn.completedAt);
      if (Number.isNaN(latestTurnCompletedAtMs)) return thread;
      const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
      if (thread.lastVisitedAt === unreadVisitedAt) return thread;
      return { ...thread, lastVisitedAt: unreadVisitedAt };
    }),
  };
}

export function toggleProject(state: AppState, projectId: Project["id"]): AppState {
  return {
    ...state,
    projects: state.projects.map((p) =>
      p.id === projectId ? { ...p, expanded: !p.expanded } : p,
    ),
  };
}

export function setProjectExpanded(
  state: AppState,
  projectId: Project["id"],
  expanded: boolean,
): AppState {
  return {
    ...state,
    projects: state.projects.map((p) =>
      p.id === projectId ? { ...p, expanded } : p,
    ),
  };
}

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  return {
    ...state,
    threads: updateThread(state.threads, threadId, (t) => ({ ...t, error })),
  };
}

export function setThreadBranch(
  state: AppState,
  threadId: ThreadId,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  return {
    ...state,
    threads: updateThread(state.threads, threadId, (t) => {
      const cwdChanged = t.worktreePath !== worktreePath;
      return {
        ...t,
        branch,
        worktreePath,
        ...(cwdChanged ? { session: null } : {}),
      };
    }),
  };
}

export function setRuntimeMode(state: AppState, mode: RuntimeMode): AppState {
  return { ...state, runtimeMode: mode };
}

// ── Zustand store ────────────────────────────────────────────────────

interface AppStore extends AppState {
  syncServerReadModel: (readModel: OrchestrationReadModel) => void;
  markThreadVisited: (threadId: ThreadId, visitedAt?: string) => void;
  markThreadUnread: (threadId: ThreadId) => void;
  toggleProject: (projectId: Project["id"]) => void;
  setProjectExpanded: (projectId: Project["id"], expanded: boolean) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadBranch: (
    threadId: ThreadId,
    branch: string | null,
    worktreePath: string | null,
  ) => void;
  setRuntimeMode: (mode: RuntimeMode) => void;
}

export const useAppStore = create<AppStore>((set, _get) => ({
  ...readPersistedState(),
  syncServerReadModel: (readModel) =>
    set((state) => syncServerReadModel(state, readModel)),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId) =>
    set((state) => markThreadUnread(state, threadId)),
  toggleProject: (projectId) =>
    set((state) => toggleProject(state, projectId)),
  setProjectExpanded: (projectId, expanded) =>
    set((state) => setProjectExpanded(state, projectId, expanded)),
  setError: (threadId, error) =>
    set((state) => setError(state, threadId, error)),
  setThreadBranch: (threadId, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadId, branch, worktreePath)),
  setRuntimeMode: (mode) =>
    set((state) => setRuntimeMode(state, mode)),
}));

// Persist on every state change (only runtimeMode + expandedProjectCwds)
useAppStore.subscribe((state) => persistState(state));

// ── useStore (state + store API for call sites that want both) ────────────────

export function StoreProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    persistState(useAppStore.getState());
  }, []);
  return createElement(Fragment, null, children);
}

export function useStore() {
  const state = useAppStore((s) => ({
    projects: s.projects,
    threads: s.threads,
    threadsHydrated: s.threadsHydrated,
    runtimeMode: s.runtimeMode,
  }));
  return {
    state,
    dispatch: useAppStore.getState(),
  };
}
