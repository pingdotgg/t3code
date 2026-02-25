import {
  type Dispatch,
  type ReactNode,
  createContext,
  createElement,
  useContext,
  useEffect,
  useReducer,
} from "react";

import { type OrchestrationReadModel, type OrchestrationSessionStatus } from "@t3tools/contracts";
import { DEFAULT_MODEL, resolveModelSlug } from "./model-logic";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  DEFAULT_RUNTIME_MODE,
  MAX_THREAD_TERMINAL_COUNT,
  type ChatMessage,
  type ProjectScript,
  type Project,
  type RuntimeMode,
  type Thread,
  type ThreadTerminalGroup,
} from "./types";

// ── Actions ──────────────────────────────────────────────────────────

type Action =
  | { type: "SYNC_SERVER_READ_MODEL"; readModel: OrchestrationReadModel }
  | { type: "MARK_THREAD_VISITED"; threadId: string; visitedAt?: string }
  | { type: "TOGGLE_PROJECT"; projectId: string }
  | { type: "TOGGLE_THREAD_TERMINAL"; threadId: string }
  | { type: "SET_THREAD_TERMINAL_OPEN"; threadId: string; open: boolean }
  | { type: "SET_THREAD_TERMINAL_HEIGHT"; threadId: string; height: number }
  | { type: "SPLIT_THREAD_TERMINAL"; threadId: string; terminalId: string }
  | { type: "NEW_THREAD_TERMINAL"; threadId: string; terminalId: string }
  | { type: "SET_THREAD_ACTIVE_TERMINAL"; threadId: string; terminalId: string }
  | { type: "CLOSE_THREAD_TERMINAL"; threadId: string; terminalId: string }
  | { type: "SET_ERROR"; threadId: string; error: string | null }
  | {
      type: "SET_THREAD_BRANCH";
      threadId: string;
      branch: string | null;
      worktreePath: string | null;
    }
  | { type: "SET_RUNTIME_MODE"; mode: RuntimeMode };

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  threadsHydrated: boolean;
  runtimeMode: RuntimeMode;
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

// ── Helpers ──────────────────────────────────────────────────────────

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

function updateThread(
  threads: Thread[],
  threadId: string,
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

function normalizeTerminalIds(terminalIds: string[]): string[] {
  const ids = terminalIds.map((id) => id.trim()).filter((id) => id.length > 0);
  const unique = [...new Set(ids)].slice(0, MAX_THREAD_TERMINAL_COUNT);
  if (unique.length > 0) {
    return unique;
  }
  return [DEFAULT_THREAD_TERMINAL_ID];
}

function normalizeRunningTerminalIds(
  runningTerminalIds: string[],
  terminalIds: string[],
): string[] {
  if (runningTerminalIds.length === 0) return [];
  const validTerminalIdSet = new Set(terminalIds);
  return [...new Set(runningTerminalIds)]
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && validTerminalIdSet.has(id));
}

function normalizeTerminalGroupIds(terminalIds: string[]): string[] {
  return [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
}

function fallbackGroupId(terminalId: string): string {
  return `group-${terminalId}`;
}

function assignUniqueGroupId(groupId: string, usedGroupIds: Set<string>): string {
  if (!usedGroupIds.has(groupId)) {
    usedGroupIds.add(groupId);
    return groupId;
  }
  let suffix = 2;
  while (usedGroupIds.has(`${groupId}-${suffix}`)) {
    suffix += 1;
  }
  const uniqueGroupId = `${groupId}-${suffix}`;
  usedGroupIds.add(uniqueGroupId);
  return uniqueGroupId;
}

function normalizeTerminalGroups(thread: Thread, terminalIds: string[]): ThreadTerminalGroup[] {
  const validTerminalIdSet = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const usedGroupIds = new Set<string>();
  const groups: ThreadTerminalGroup[] = [];

  for (const group of thread.terminalGroups) {
    const groupTerminalIds = normalizeTerminalGroupIds(group.terminalIds).filter((terminalId) => {
      if (!validTerminalIdSet.has(terminalId)) return false;
      if (assignedTerminalIds.has(terminalId)) return false;
      return true;
    });
    if (groupTerminalIds.length === 0) continue;
    for (const terminalId of groupTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }
    const baseGroupId =
      group.id.trim().length > 0
        ? group.id.trim()
        : fallbackGroupId(groupTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
    groups.push({
      id: assignUniqueGroupId(baseGroupId, usedGroupIds),
      terminalIds: groupTerminalIds,
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    groups.push({
      id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  if (groups.length > 0) {
    return groups;
  }

  return [
    {
      id: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
    },
  ];
}

function findGroupIndexByTerminalId(
  terminalGroups: ThreadTerminalGroup[],
  terminalId: string,
): number {
  return terminalGroups.findIndex((group) => group.terminalIds.includes(terminalId));
}

function normalizeThreadTerminals(thread: Thread): Thread {
  const terminalIds = normalizeTerminalIds(thread.terminalIds);
  const activeTerminalId = terminalIds.includes(thread.activeTerminalId)
    ? thread.activeTerminalId
    : (terminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
  const terminalGroups = normalizeTerminalGroups(thread, terminalIds);
  const activeGroupIndexFromId = terminalGroups.findIndex(
    (group) => group.id === thread.activeTerminalGroupId,
  );
  const activeGroupIndexFromTerminal = findGroupIndexByTerminalId(terminalGroups, activeTerminalId);
  const activeGroupIndex =
    activeGroupIndexFromId >= 0
      ? activeGroupIndexFromId
      : activeGroupIndexFromTerminal >= 0
        ? activeGroupIndexFromTerminal
        : 0;
  const activeTerminalGroupId =
    terminalGroups[activeGroupIndex]?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(activeTerminalId);

  return {
    ...thread,
    terminalIds,
    runningTerminalIds: normalizeRunningTerminalIds(thread.runningTerminalIds, terminalIds),
    activeTerminalId,
    terminalGroups,
    activeTerminalGroupId,
  };
}

function closeThreadTerminal(thread: Thread, terminalId: string): Thread {
  if (!thread.terminalIds.includes(terminalId)) {
    return thread;
  }

  const remainingTerminalIds = thread.terminalIds.filter((id) => id !== terminalId);
  if (remainingTerminalIds.length === 0) {
    const nextTerminalGroupId = fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID);
    return normalizeThreadTerminals({
      ...thread,
      terminalOpen: false,
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      runningTerminalIds: [],
      activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
      terminalGroups: [
        {
          id: nextTerminalGroupId,
          terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
        },
      ],
      activeTerminalGroupId: nextTerminalGroupId,
    });
  }

  const closedTerminalIndex = thread.terminalIds.indexOf(terminalId);
  const closedTerminalGroup = thread.terminalGroups.find((group) =>
    group.terminalIds.includes(terminalId),
  );
  const closedTerminalGroupIndex = closedTerminalGroup
    ? closedTerminalGroup.terminalIds.indexOf(terminalId)
    : -1;
  const remainingTerminalsInClosedGroup = (closedTerminalGroup?.terminalIds ?? []).filter(
    (id) => id !== terminalId,
  );
  const nextActiveTerminalId =
    thread.activeTerminalId === terminalId
      ? (remainingTerminalsInClosedGroup[
          Math.min(closedTerminalGroupIndex, remainingTerminalsInClosedGroup.length - 1)
        ] ??
        remainingTerminalIds[Math.min(closedTerminalIndex, remainingTerminalIds.length - 1)] ??
        remainingTerminalIds[0] ??
        DEFAULT_THREAD_TERMINAL_ID)
      : thread.activeTerminalId;
  const nextTerminalGroups = thread.terminalGroups
    .map((group) => ({
      ...group,
      terminalIds: group.terminalIds.filter((id) => id !== terminalId),
    }))
    .filter((group) => group.terminalIds.length > 0);

  return normalizeThreadTerminals({
    ...thread,
    terminalIds: remainingTerminalIds,
    runningTerminalIds: thread.runningTerminalIds.filter((id) => id !== terminalId),
    activeTerminalId: nextActiveTerminalId,
    terminalGroups: nextTerminalGroups,
  });
}

// ── Reducer ──────────────────────────────────────────────────────────

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SYNC_SERVER_READ_MODEL": {
      const projects = mapProjectsFromReadModel(
        action.readModel.projects.filter((project) => project.deletedAt === null),
        state.projects,
      );
      const existingThreadById = new Map(
        state.threads.map((thread) => [thread.id, thread] as const),
      );
      const threads = action.readModel.threads
        .filter((thread) => thread.deletedAt === null)
        .map((thread) => {
          const existing = existingThreadById.get(thread.id);
          const latestTurnStartedAt =
            thread.latestTurnId === null
              ? undefined
              : thread.messages.find(
                  (message) => message.turnId === thread.latestTurnId && message.role === "user",
                )?.createdAt;
          const latestTurnCompletedAt = thread.checkpoints.find(
            (checkpoint) => checkpoint.turnId === thread.latestTurnId,
          )?.completedAt;
          const latestTurnDurationMs =
            latestTurnStartedAt && latestTurnCompletedAt
              ? Math.max(0, Date.parse(latestTurnCompletedAt) - Date.parse(latestTurnStartedAt))
              : undefined;

          return normalizeThreadTerminals({
            id: thread.id,
            codexThreadId: thread.session?.providerThreadId ?? null,
            projectId: thread.projectId,
            title: thread.title,
            model: resolveModelSlug(thread.model),
            terminalOpen: existing?.terminalOpen ?? false,
            terminalHeight: existing?.terminalHeight ?? DEFAULT_THREAD_TERMINAL_HEIGHT,
            terminalIds: existing?.terminalIds ?? [DEFAULT_THREAD_TERMINAL_ID],
            runningTerminalIds: existing?.runningTerminalIds ?? [],
            activeTerminalId: existing?.activeTerminalId ?? DEFAULT_THREAD_TERMINAL_ID,
            terminalGroups: existing?.terminalGroups ?? [
              {
                id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
                terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
              },
            ],
            activeTerminalGroupId:
              existing?.activeTerminalGroupId ?? `group-${DEFAULT_THREAD_TERMINAL_ID}`,
            session: thread.session
              ? {
                  sessionId: thread.session.providerSessionId ?? `thread:${thread.id}`,
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
              const attachments = message.attachments?.map((attachment, index) => ({
                type: "image" as const,
                id: `${message.id}:${index}`,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                previewUrl: attachment.dataUrl,
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
            latestTurnId: thread.latestTurnId ?? undefined,
            latestTurnStartedAt,
            latestTurnCompletedAt,
            latestTurnDurationMs,
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
          });
        });
      return {
        ...state,
        projects,
        threads,
        threadsHydrated: true,
      };
    }

    case "MARK_THREAD_VISITED": {
      const visitedAt = action.visitedAt ?? new Date().toISOString();
      const visitedAtMs = Date.parse(visitedAt);
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) => {
          const previousVisitedAtMs = thread.lastVisitedAt ? Date.parse(thread.lastVisitedAt) : NaN;
          if (
            Number.isFinite(previousVisitedAtMs) &&
            Number.isFinite(visitedAtMs) &&
            previousVisitedAtMs >= visitedAtMs
          ) {
            return thread;
          }
          return {
            ...thread,
            lastVisitedAt: visitedAt,
          };
        }),
      };
    }

    case "TOGGLE_PROJECT":
      return {
        ...state,
        projects: state.projects.map((p) =>
          p.id === action.projectId ? { ...p, expanded: !p.expanded } : p,
        ),
      };

    case "TOGGLE_THREAD_TERMINAL":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          terminalOpen: !t.terminalOpen,
        })),
      };

    case "SET_THREAD_TERMINAL_OPEN":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          terminalOpen: action.open,
        })),
      };

    case "SET_THREAD_TERMINAL_HEIGHT":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          terminalHeight: action.height,
        })),
      };

    case "SPLIT_THREAD_TERMINAL":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) => {
          const normalizedThread = normalizeThreadTerminals(thread);
          const isNewTerminal = !normalizedThread.terminalIds.includes(action.terminalId);
          if (isNewTerminal && normalizedThread.terminalIds.length >= MAX_THREAD_TERMINAL_COUNT) {
            return normalizedThread;
          }
          const terminalIds = normalizedThread.terminalIds.includes(action.terminalId)
            ? normalizedThread.terminalIds
            : [...normalizedThread.terminalIds, action.terminalId];
          const terminalGroups = normalizedThread.terminalGroups.map((group) => ({
            ...group,
            terminalIds: [...group.terminalIds],
          }));
          let activeGroupIndex = terminalGroups.findIndex(
            (group) => group.id === normalizedThread.activeTerminalGroupId,
          );
          if (activeGroupIndex < 0) {
            activeGroupIndex = findGroupIndexByTerminalId(
              terminalGroups,
              normalizedThread.activeTerminalId,
            );
          }
          if (activeGroupIndex < 0) {
            terminalGroups.push({
              id: fallbackGroupId(normalizedThread.activeTerminalId),
              terminalIds: [normalizedThread.activeTerminalId],
            });
            activeGroupIndex = terminalGroups.length - 1;
          }

          const existingGroupIndex = findGroupIndexByTerminalId(terminalGroups, action.terminalId);
          if (existingGroupIndex >= 0) {
            terminalGroups[existingGroupIndex]!.terminalIds = terminalGroups[
              existingGroupIndex
            ]!.terminalIds.filter((id) => id !== action.terminalId);
            if (terminalGroups[existingGroupIndex]!.terminalIds.length === 0) {
              terminalGroups.splice(existingGroupIndex, 1);
              if (existingGroupIndex < activeGroupIndex) {
                activeGroupIndex -= 1;
              }
            }
          }

          const destinationGroup = terminalGroups[activeGroupIndex];
          if (!destinationGroup) {
            return normalizedThread;
          }
          if (!destinationGroup.terminalIds.includes(action.terminalId)) {
            const anchorIndex = destinationGroup.terminalIds.indexOf(
              normalizedThread.activeTerminalId,
            );
            if (anchorIndex >= 0) {
              destinationGroup.terminalIds.splice(anchorIndex + 1, 0, action.terminalId);
            } else {
              destinationGroup.terminalIds.push(action.terminalId);
            }
          }
          return normalizeThreadTerminals({
            ...normalizedThread,
            terminalIds,
            activeTerminalId: action.terminalId,
            activeTerminalGroupId: destinationGroup.id,
            terminalGroups,
          });
        }),
      };

    case "NEW_THREAD_TERMINAL":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) => {
          const normalizedThread = normalizeThreadTerminals(thread);
          const isNewTerminal = !normalizedThread.terminalIds.includes(action.terminalId);
          if (isNewTerminal && normalizedThread.terminalIds.length >= MAX_THREAD_TERMINAL_COUNT) {
            return normalizedThread;
          }
          const terminalIds = normalizedThread.terminalIds.includes(action.terminalId)
            ? normalizedThread.terminalIds
            : [...normalizedThread.terminalIds, action.terminalId];
          const terminalGroups = normalizedThread.terminalGroups
            .map((group) => ({
              ...group,
              terminalIds: group.terminalIds.filter((id) => id !== action.terminalId),
            }))
            .filter((group) => group.terminalIds.length > 0);
          const nextGroupId = fallbackGroupId(action.terminalId);
          terminalGroups.push({ id: nextGroupId, terminalIds: [action.terminalId] });

          return normalizeThreadTerminals({
            ...normalizedThread,
            terminalIds,
            activeTerminalId: action.terminalId,
            activeTerminalGroupId: nextGroupId,
            terminalGroups,
          });
        }),
      };

    case "SET_THREAD_ACTIVE_TERMINAL":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) => {
          const normalizedThread = normalizeThreadTerminals(thread);
          if (!normalizedThread.terminalIds.includes(action.terminalId)) {
            return thread;
          }
          const nextActiveGroupIndex = findGroupIndexByTerminalId(
            normalizedThread.terminalGroups,
            action.terminalId,
          );
          const activeTerminalGroupId =
            nextActiveGroupIndex >= 0
              ? (normalizedThread.terminalGroups[nextActiveGroupIndex]?.id ??
                normalizedThread.activeTerminalGroupId)
              : normalizedThread.activeTerminalGroupId;
          return normalizeThreadTerminals({
            ...normalizedThread,
            activeTerminalId: action.terminalId,
            activeTerminalGroupId,
          });
        }),
      };

    case "CLOSE_THREAD_TERMINAL":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (thread) =>
          closeThreadTerminal(thread, action.terminalId),
        ),
      };

    case "SET_ERROR":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          error: action.error,
        })),
      };

    case "SET_THREAD_BRANCH": {
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => {
          // When the effective cwd changes (worktreePath differs), the old
          // session is no longer valid — clear it so ensureSession creates a
          // new one with the correct cwd on the next message.
          const cwdChanged = t.worktreePath !== action.worktreePath;
          return {
            ...t,
            branch: action.branch,
            worktreePath: action.worktreePath,
            ...(cwdChanged ? { session: null } : {}),
          };
        }),
      };
    }

    case "SET_RUNTIME_MODE":
      return {
        ...state,
        runtimeMode: action.mode,
      };

    default:
      return state;
  }
}

// ── Context ──────────────────────────────────────────────────────────

const StoreContext = createContext<{
  state: AppState;
  dispatch: Dispatch<Action>;
}>({ state: initialState, dispatch: () => {} });

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, readPersistedState);

  useEffect(() => {
    persistState(state);
  }, [state]);

  return createElement(StoreContext.Provider, { value: { state, dispatch } }, children);
}

export function useStore() {
  return useContext(StoreContext);
}
