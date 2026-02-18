import {
  type Dispatch,
  type ReactNode,
  createContext,
  createElement,
  useContext,
  useEffect,
  useReducer,
} from "react";

import { type ProviderEvent, type ProviderSession, type TerminalEvent, normalizeProjectScripts } from "@t3tools/contracts";
import { resolveModelSlug } from "./model-logic";
import { hydratePersistedState, toPersistedState } from "./persistenceSchema";
import {
  applyEventToMessages,
  asObject,
  asString,
  deriveTurnDiffFilesFromUnifiedDiff,
  deriveTurnDiffSummaries,
  inferCheckpointTurnCountByTurnId,
  evolveSession,
} from "./session-logic";
import {
  type ChatAttachment,
  DEFAULT_THREAD_TERMINAL_ID,
  DEFAULT_RUNTIME_MODE,
  MAX_THREAD_TERMINAL_COUNT,
  type ProjectScript,
  type Project,
  type RuntimeMode,
  type Thread,
  type ThreadTerminalGroup,
} from "./types";

// ── Actions ──────────────────────────────────────────────────────────

type Action =
  | { type: "ADD_PROJECT"; project: Project }
  | { type: "SET_PROJECT_SCRIPTS"; projectId: string; scripts: ProjectScript[] }
  | { type: "SYNC_PROJECTS"; projects: Project[] }
  | { type: "TOGGLE_PROJECT"; projectId: string }
  | { type: "DELETE_PROJECT"; projectId: string }
  | { type: "ADD_THREAD"; thread: Thread }
  | { type: "SET_ACTIVE_THREAD"; threadId: string }
  | { type: "TOGGLE_THREAD_TERMINAL"; threadId: string }
  | { type: "SET_THREAD_TERMINAL_OPEN"; threadId: string; open: boolean }
  | { type: "SET_THREAD_TERMINAL_HEIGHT"; threadId: string; height: number }
  | { type: "SPLIT_THREAD_TERMINAL"; threadId: string; terminalId: string }
  | { type: "NEW_THREAD_TERMINAL"; threadId: string; terminalId: string }
  | { type: "SET_THREAD_ACTIVE_TERMINAL"; threadId: string; terminalId: string }
  | { type: "CLOSE_THREAD_TERMINAL"; threadId: string; terminalId: string }
  | { type: "TOGGLE_DIFF" }
  | {
      type: "OPEN_DIFF";
      threadId: string;
      turnId?: string;
      filePath?: string;
    }
  | {
      type: "SET_DIFF_TARGET";
      threadId: string;
      turnId?: string;
      filePath?: string;
    }
  | { type: "CLOSE_DIFF" }
  | {
      type: "APPLY_EVENT";
      event: ProviderEvent;
      activeAssistantItemRef: { current: string | null };
    }
  | { type: "APPLY_TERMINAL_EVENT"; event: TerminalEvent }
  | { type: "UPDATE_SESSION"; threadId: string; session: ProviderSession }
  | {
      type: "PUSH_USER_MESSAGE";
      threadId: string;
      id: string;
      text: string;
      attachments?: ChatAttachment[];
    }
  | { type: "SET_ERROR"; threadId: string; error: string | null }
  | { type: "SET_THREAD_TITLE"; threadId: string; title: string }
  | { type: "SET_THREAD_MODEL"; threadId: string; model: string }
  | {
      type: "REVERT_TO_CHECKPOINT";
      threadId: string;
      sessionId: string;
      threadRuntimeId: string;
      turnCount: number;
      messageCount: number;
    }
  | {
      type: "SET_THREAD_TURN_CHECKPOINT_COUNTS";
      threadId: string;
      checkpointTurnCountByTurnId: Record<string, number>;
    }
  | {
      type: "SET_THREAD_TURN_CHECKPOINT_DIFFS";
      threadId: string;
      checkpointDiffByTurnId: Record<string, string>;
    }
  | {
      type: "SET_THREAD_BRANCH";
      threadId: string;
      branch: string | null;
      worktreePath: string | null;
    }
  | { type: "SET_RUNTIME_MODE"; mode: RuntimeMode }
  | { type: "DELETE_THREAD"; threadId: string };

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  activeThreadId: string | null;
  runtimeMode: RuntimeMode;
  diffOpen: boolean;
  diffThreadId: string | null;
  diffTurnId: string | null;
  diffFilePath: string | null;
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
  activeThreadId: null,
  runtimeMode: DEFAULT_RUNTIME_MODE,
  diffOpen: false,
  diffThreadId: null,
  diffTurnId: null,
  diffFilePath: null,
};

// ── Helpers ──────────────────────────────────────────────────────────

function readPersistedState(): AppState {
  if (typeof window === "undefined") return initialState;

  try {
    const rawCurrent = window.localStorage.getItem(PERSISTED_STATE_KEY);
    const legacyValues = LEGACY_PERSISTED_STATE_KEYS.map((key) => window.localStorage.getItem(key));
    const rawLegacy = legacyValues.find((value) => value !== null) ?? null;
    const raw = rawCurrent ?? rawLegacy;
    if (!raw) return initialState;
    const rawCodethingV1 = window.localStorage.getItem("codething:renderer-state:v1");
    const hydrated = hydratePersistedState(raw, !rawCurrent && raw === rawCodethingV1);
    if (!hydrated) return initialState;

    const threads = hydrated.threads.map((thread) => normalizeThreadTerminals(thread));
    const activeThreadId = threads.some((thread) => thread.id === hydrated.activeThreadId)
      ? hydrated.activeThreadId
      : (threads[0]?.id ?? null);

    return {
      ...hydrated,
      threads,
      activeThreadId,
      diffOpen: false,
      diffThreadId: null,
      diffTurnId: null,
      diffFilePath: null,
    };
  } catch {
    return initialState;
  }
}

function persistState(state: AppState): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(PERSISTED_STATE_KEY, JSON.stringify(toPersistedState(state)));
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

function resetDiffTargetIfMissing(state: AppState, threads: Thread[]) {
  if (!state.diffThreadId) {
    return {
      diffOpen: state.diffOpen,
      diffThreadId: state.diffThreadId,
      diffTurnId: state.diffTurnId,
      diffFilePath: state.diffFilePath,
    };
  }
  const hasThread = threads.some((thread) => thread.id === state.diffThreadId);
  if (hasThread) {
    return {
      diffOpen: state.diffOpen,
      diffThreadId: state.diffThreadId,
      diffTurnId: state.diffTurnId,
      diffFilePath: state.diffFilePath,
    };
  }
  return {
    diffOpen: false,
    diffThreadId: null,
    diffTurnId: null,
    diffFilePath: null,
  };
}

function mergeTurnDiffSummaries(
  existing: Thread["turnDiffSummaries"],
  next: Thread["turnDiffSummaries"],
): Thread["turnDiffSummaries"] {
  if (next.length === 0) return existing;

  const existingByTurnId = new Map(existing.map((summary) => [summary.turnId, summary] as const));
  const merged = next.map((summary) => {
    const previous = existingByTurnId.get(summary.turnId);
    if (!previous) {
      return summary;
    }

    const prefersCheckpointDiff = previous.checkpointDiffLoaded || summary.checkpointDiffLoaded;
    const files =
      prefersCheckpointDiff ||
      (summary.files.length === 0 && previous.files.length > 0 && summary.unifiedDiff === undefined)
        ? previous.files
        : summary.files;
    const unifiedDiff =
      prefersCheckpointDiff || summary.unifiedDiff === undefined
        ? (previous.unifiedDiff ?? summary.unifiedDiff)
        : summary.unifiedDiff;

    return {
      ...summary,
      files,
      ...(unifiedDiff !== undefined ? { unifiedDiff } : {}),
      ...(summary.assistantMessageId
        ? {}
        : previous.assistantMessageId
          ? { assistantMessageId: previous.assistantMessageId }
          : {}),
      ...(typeof summary.checkpointTurnCount === "number"
        ? {}
        : typeof previous.checkpointTurnCount === "number"
          ? { checkpointTurnCount: previous.checkpointTurnCount }
          : {}),
      ...(summary.checkpointDiffLoaded || previous.checkpointDiffLoaded
        ? { checkpointDiffLoaded: true }
        : {}),
    };
  });

  const mergedTurnIds = new Set(merged.map((summary) => summary.turnId));
  for (const summary of existing) {
    if (!mergedTurnIds.has(summary.turnId)) {
      merged.push(summary);
    }
  }

  const sorted = merged.toSorted((a, b) => {
    const aTime = Date.parse(a.completedAt);
    const bTime = Date.parse(b.completedAt);
    if (Number.isNaN(aTime) || Number.isNaN(bTime)) {
      return b.completedAt.localeCompare(a.completedAt);
    }
    return bTime - aTime;
  });

  const inferredTurnCountByTurnId = inferCheckpointTurnCountByTurnId(sorted);
  return sorted.map((summary) =>
    typeof summary.checkpointTurnCount === "number"
      ? summary
      : Object.assign({}, summary, {
          checkpointTurnCount: inferredTurnCountByTurnId[summary.turnId],
        }),
  );
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

function findThreadBySessionId(threads: Thread[], sessionId: string): Thread | undefined {
  return threads.find((t) => t.session?.sessionId === sessionId);
}

function getEventTurnId(event: ProviderEvent): string | undefined {
  if (event.turnId) return event.turnId;
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);
  return asString(turn?.id);
}

function getEventThreadId(event: ProviderEvent): string | undefined {
  if (event.threadId) return event.threadId;
  const payload = asObject(event.payload);
  const payloadThread = asObject(payload?.thread);
  const payloadMessage = asObject(payload?.msg);
  return (
    asString(payload?.threadId) ??
    asString(payloadThread?.id) ??
    asString(payload?.conversationId) ??
    asString(payload?.thread_id) ??
    asString(payloadMessage?.thread_id)
  );
}

function shouldIgnoreForeignThreadEvent(thread: Thread, event: ProviderEvent): boolean {
  const eventThreadId = getEventThreadId(event);
  if (!eventThreadId) {
    return false;
  }

  const expectedThreadId = thread.session?.threadId ?? thread.codexThreadId;
  if (!expectedThreadId || eventThreadId === expectedThreadId) {
    return false;
  }

  // During connect, accept a thread/started notification as an identity rebind.
  if (event.method === "thread/started" && thread.session?.status === "connecting") {
    return false;
  }

  return true;
}

function durationMs(startIso: string, endIso: string): number | undefined {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return undefined;
  }

  return end - start;
}

function updateTurnFields(thread: Thread, event: ProviderEvent): Partial<Thread> {
  if (event.method === "turn/started") {
    return {
      latestTurnId: getEventTurnId(event) ?? thread.latestTurnId,
      latestTurnStartedAt: event.createdAt,
      latestTurnCompletedAt: undefined,
      latestTurnDurationMs: undefined,
    };
  }

  if (event.method === "turn/completed") {
    const completedTurnId = getEventTurnId(event) ?? thread.latestTurnId;
    const startedAt =
      completedTurnId && completedTurnId === thread.latestTurnId
        ? thread.latestTurnStartedAt
        : undefined;
    const elapsed =
      startedAt && startedAt.length > 0 ? durationMs(startedAt, event.createdAt) : undefined;

    return {
      latestTurnId: completedTurnId ?? thread.latestTurnId,
      latestTurnCompletedAt: event.createdAt,
      latestTurnDurationMs: elapsed,
    };
  }

  return {};
}

// ── Reducer ──────────────────────────────────────────────────────────

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "ADD_PROJECT":
      if (state.projects.some((project) => project.cwd === action.project.cwd)) {
        return state;
      }
      return {
        ...state,
        projects: [
          ...state.projects,
          {
            ...action.project,
            model: resolveModelSlug(action.project.model),
            scripts: normalizeProjectScripts(action.project.scripts),
          },
        ],
      };

    case "SET_PROJECT_SCRIPTS":
      return {
        ...state,
        projects: state.projects.map((project) =>
          project.id === action.projectId
            ? { ...project, scripts: normalizeProjectScripts(action.scripts) }
            : project,
        ),
      };

    case "SYNC_PROJECTS": {
      const previousByCwd = new Map(
        state.projects.map((project) => [project.cwd, project] as const),
      );
      const nextProjects = action.projects.map((project) => {
        const previous = previousByCwd.get(project.cwd);
        const scripts = normalizeProjectScripts(project.scripts);
        return {
          ...project,
          model: resolveModelSlug(previous?.model ?? project.model),
          expanded: previous?.expanded ?? project.expanded,
          scripts,
        };
      });
      const previousProjectById = new Map(
        state.projects.map((project) => [project.id, project] as const),
      );
      const nextProjectIdByCwd = new Map(
        nextProjects.map((project) => [project.cwd, project.id] as const),
      );
      const nextThreads = state.threads
        .map((thread) => {
          const previousProject = previousProjectById.get(thread.projectId);
          if (!previousProject) return null;
          const mappedProjectId = nextProjectIdByCwd.get(previousProject.cwd);
          if (!mappedProjectId) return null;
          return normalizeThreadTerminals({
            ...thread,
            projectId: mappedProjectId,
          });
        })
        .filter((thread): thread is Thread => thread !== null);
      const activeThreadId = nextThreads.some((thread) => thread.id === state.activeThreadId)
        ? state.activeThreadId
        : (nextThreads[0]?.id ?? null);
      const diffState = resetDiffTargetIfMissing(state, nextThreads);

      return {
        ...state,
        projects: nextProjects,
        threads: nextThreads,
        activeThreadId,
        ...diffState,
      };
    }

    case "TOGGLE_PROJECT":
      return {
        ...state,
        projects: state.projects.map((p) =>
          p.id === action.projectId ? { ...p, expanded: !p.expanded } : p,
        ),
      };

    case "DELETE_PROJECT": {
      const projects = state.projects.filter((project) => project.id !== action.projectId);
      if (projects.length === state.projects.length) {
        return state;
      }

      const threads = state.threads.filter((thread) => thread.projectId !== action.projectId);
      const activeThreadId = threads.some((thread) => thread.id === state.activeThreadId)
        ? state.activeThreadId
        : (threads[0]?.id ?? null);
      const diffState = resetDiffTargetIfMissing(state, threads);

      return {
        ...state,
        projects,
        threads,
        activeThreadId,
        ...diffState,
      };
    }

    case "ADD_THREAD": {
      const nextThread = normalizeThreadTerminals({
        ...action.thread,
        model: resolveModelSlug(action.thread.model),
        lastVisitedAt: action.thread.lastVisitedAt ?? action.thread.createdAt,
        turnDiffSummaries: action.thread.turnDiffSummaries ?? [],
      });
      return {
        ...state,
        threads: [...state.threads, nextThread],
        activeThreadId: action.thread.id,
      };
    }

    case "SET_ACTIVE_THREAD": {
      const visitedAt = new Date().toISOString();
      return {
        ...state,
        activeThreadId: action.threadId,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          lastVisitedAt: visitedAt,
        })),
      };
    }

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
          if (
            isNewTerminal &&
            normalizedThread.terminalIds.length >= MAX_THREAD_TERMINAL_COUNT
          ) {
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
          if (
            isNewTerminal &&
            normalizedThread.terminalIds.length >= MAX_THREAD_TERMINAL_COUNT
          ) {
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

    case "TOGGLE_DIFF":
      return { ...state, diffOpen: !state.diffOpen };

    case "OPEN_DIFF":
      return {
        ...state,
        diffOpen: true,
        diffThreadId: action.threadId,
        diffTurnId: action.turnId ?? null,
        diffFilePath: action.filePath ?? null,
      };

    case "SET_DIFF_TARGET":
      return {
        ...state,
        diffThreadId: action.threadId,
        diffTurnId: action.turnId ?? null,
        diffFilePath: action.filePath ?? null,
      };

    case "CLOSE_DIFF":
      return { ...state, diffOpen: false };

    case "APPLY_TERMINAL_EVENT":
      if (!state.threads.some((thread) => thread.id === action.event.threadId)) {
        return state;
      }
      return {
        ...state,
        threads: updateThread(state.threads, action.event.threadId, (thread) => {
          const normalizedThread = normalizeThreadTerminals(thread);
          const runningTerminalIdSet = new Set(normalizedThread.runningTerminalIds);
          if (action.event.type === "started" || action.event.type === "restarted") {
            runningTerminalIdSet.delete(action.event.terminalId);
          } else if (action.event.type === "activity") {
            if (action.event.hasRunningSubprocess) {
              runningTerminalIdSet.add(action.event.terminalId);
            } else {
              runningTerminalIdSet.delete(action.event.terminalId);
            }
          } else if (action.event.type === "exited" || action.event.type === "error") {
            runningTerminalIdSet.delete(action.event.terminalId);
          }

          return normalizeThreadTerminals({
            ...normalizedThread,
            runningTerminalIds: [...runningTerminalIdSet],
          });
        }),
      };

    case "APPLY_EVENT": {
      const { event, activeAssistantItemRef } = action;
      const target = findThreadBySessionId(state.threads, event.sessionId);
      if (!target) return state;
      if (shouldIgnoreForeignThreadEvent(target, event)) return state;

      return {
        ...state,
        threads: updateThread(state.threads, target.id, (t) => {
          const nextEvents = [event, ...t.events];
          const itemType = asString(asObject(asObject(event.payload)?.item)?.type);
          const normalizedItemType = itemType?.replace(/[_-]/g, "").toLowerCase();
          const shouldRederiveDiffs =
            event.method === "turn/completed" ||
            event.method === "turn/diff/updated" ||
            (event.method === "item/completed" &&
              (normalizedItemType === "agentmessage" || normalizedItemType === "filechange"));
          const turnDiffSummaries = shouldRederiveDiffs
            ? mergeTurnDiffSummaries(t.turnDiffSummaries, deriveTurnDiffSummaries(nextEvents))
            : t.turnDiffSummaries;
          const eventThreadId = getEventThreadId(event);
          const shouldRebindIdentity =
            event.method === "thread/started" && t.session?.status === "connecting";
          return {
            ...t,
            codexThreadId: shouldRebindIdentity
              ? (eventThreadId ?? t.codexThreadId)
              : (t.codexThreadId ?? eventThreadId ?? null),
            error: event.kind === "error" && event.message ? event.message : t.error,
            session: t.session ? evolveSession(t.session, event) : t.session,
            messages: applyEventToMessages(t.messages, event, activeAssistantItemRef),
            events: nextEvents,
            turnDiffSummaries,
            ...updateTurnFields(t, event),
            ...(event.method === "turn/completed" && t.id === state.activeThreadId
              ? { lastVisitedAt: event.createdAt }
              : {}),
          };
        }),
      };
    }

    case "UPDATE_SESSION":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          session: action.session,
          codexThreadId: action.session.threadId ?? t.codexThreadId,
          events: [],
          error: null,
          latestTurnId: undefined,
          latestTurnStartedAt: undefined,
          latestTurnCompletedAt: undefined,
          latestTurnDurationMs: undefined,
        })),
      };

    case "PUSH_USER_MESSAGE":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          messages: [
            ...t.messages,
            {
              id: action.id,
              role: "user" as const,
              text: action.text,
              ...(action.attachments && action.attachments.length > 0
                ? { attachments: action.attachments }
                : {}),
              createdAt: new Date().toISOString(),
              streaming: false,
            },
          ],
        })),
      };

    case "SET_ERROR":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          error: action.error,
        })),
      };

    case "SET_THREAD_TITLE":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          title: action.title,
        })),
      };

    case "SET_THREAD_MODEL":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          model: resolveModelSlug(action.model),
        })),
      };

    case "REVERT_TO_CHECKPOINT":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => {
          const nextMessageCount = Math.max(0, Math.floor(action.messageCount));
          const nextTurnCount = Math.max(0, Math.floor(action.turnCount));
          const now = new Date().toISOString();
          return {
            ...t,
            codexThreadId: action.threadRuntimeId,
            session:
              t.session?.sessionId === action.sessionId
                ? {
                    ...t.session,
                    status: "ready",
                    threadId: action.threadRuntimeId,
                    activeTurnId: undefined,
                    updatedAt: now,
                    lastError: undefined,
                  }
                : t.session,
            messages: t.messages.slice(0, nextMessageCount),
            events: [],
            turnDiffSummaries: t.turnDiffSummaries.filter(
              (summary) =>
                typeof summary.checkpointTurnCount === "number" &&
                summary.checkpointTurnCount <= nextTurnCount,
            ),
            error: null,
            latestTurnId: undefined,
            latestTurnStartedAt: undefined,
            latestTurnCompletedAt: undefined,
            latestTurnDurationMs: undefined,
            lastVisitedAt: now,
          };
        }),
      };

    case "SET_THREAD_TURN_CHECKPOINT_COUNTS":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => {
          const hasUpdates = t.turnDiffSummaries.some(
            (summary) =>
              action.checkpointTurnCountByTurnId[summary.turnId] !== undefined &&
              action.checkpointTurnCountByTurnId[summary.turnId] !== summary.checkpointTurnCount,
          );
          if (!hasUpdates) {
            return t;
          }
          return {
            ...t,
            turnDiffSummaries: t.turnDiffSummaries.map((summary) => {
              const turnCount = action.checkpointTurnCountByTurnId[summary.turnId];
              if (turnCount === undefined) {
                return summary;
              }
              return {
                ...summary,
                checkpointTurnCount: turnCount,
              };
            }),
          };
        }),
      };

    case "SET_THREAD_TURN_CHECKPOINT_DIFFS":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => {
          let hasUpdates = false;
          const updatedSummaries = t.turnDiffSummaries.map((summary) => {
            const checkpointDiff = action.checkpointDiffByTurnId[summary.turnId];
            if (checkpointDiff === undefined) {
              return summary;
            }

            const files = deriveTurnDiffFilesFromUnifiedDiff(checkpointDiff);
            const filesUnchanged =
              files.length === summary.files.length &&
              files.every((file, index) => {
                const existing = summary.files[index];
                return (
                  existing !== undefined &&
                  existing.path === file.path &&
                  existing.diff === file.diff &&
                  existing.kind === file.kind &&
                  existing.additions === file.additions &&
                  existing.deletions === file.deletions
                );
              });
            if (
              summary.unifiedDiff === checkpointDiff &&
              filesUnchanged &&
              summary.checkpointDiffLoaded
            ) {
              return summary;
            }

            hasUpdates = true;
            return {
              ...summary,
              unifiedDiff: checkpointDiff,
              files,
              checkpointDiffLoaded: true,
            };
          });

          if (!hasUpdates) {
            return t;
          }

          return {
            ...t,
            turnDiffSummaries: updatedSummaries,
          };
        }),
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

    case "DELETE_THREAD": {
      const threads = state.threads.filter((t) => t.id !== action.threadId);
      const activeThreadId =
        state.activeThreadId === action.threadId ? (threads[0]?.id ?? null) : state.activeThreadId;
      const shouldClearDiffTarget = state.diffThreadId === action.threadId;
      return {
        ...state,
        threads,
        activeThreadId,
        ...(shouldClearDiffTarget
          ? {
              diffOpen: false,
              diffThreadId: null,
              diffTurnId: null,
              diffFilePath: null,
            }
          : {}),
      };
    }

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
