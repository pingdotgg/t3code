import {
  type Dispatch,
  type ReactNode,
  createContext,
  createElement,
  useContext,
  useEffect,
  useReducer,
} from "react";

import type { ProviderEvent, ProviderSession } from "@t3tools/contracts";
import { resolveModelSlug } from "./model-logic";
import { hydratePersistedState, toPersistedState } from "./persistenceSchema";
import { applyEventToMessages, asObject, asString, evolveSession } from "./session-logic";
import {
  type ChatAttachment,
  DEFAULT_RUNTIME_MODE,
  type Project,
  type RuntimeMode,
  type Thread,
} from "./types";

// ── Actions ──────────────────────────────────────────────────────────

type Action =
  | { type: "ADD_PROJECT"; project: Project }
  | { type: "SYNC_PROJECTS"; projects: Project[] }
  | { type: "TOGGLE_PROJECT"; projectId: string }
  | { type: "ADD_THREAD"; thread: Thread }
  | { type: "SET_ACTIVE_THREAD"; threadId: string }
  | { type: "TOGGLE_THREAD_TERMINAL"; threadId: string }
  | { type: "SET_THREAD_TERMINAL_OPEN"; threadId: string; open: boolean }
  | { type: "SET_THREAD_TERMINAL_HEIGHT"; threadId: string; height: number }
  | { type: "TOGGLE_DIFF" }
  | {
      type: "APPLY_EVENT";
      event: ProviderEvent;
      activeAssistantItemRef: { current: string | null };
    }
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
}

const PERSISTED_STATE_KEY = "t3code:renderer-state:v6";
const LEGACY_PERSISTED_STATE_KEYS = [
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
};

// ── Helpers ──────────────────────────────────────────────────────────

function readPersistedState(): AppState {
  if (typeof window === "undefined") return initialState;

  try {
    const rawCurrent = window.localStorage.getItem(PERSISTED_STATE_KEY);
    const legacyValues = LEGACY_PERSISTED_STATE_KEYS.map((key) =>
      window.localStorage.getItem(key),
    );
    const rawLegacy = legacyValues.find((value) => value !== null) ?? null;
    const raw = rawCurrent ?? rawLegacy;
    if (!raw) return initialState;
    const rawCodethingV1 = window.localStorage.getItem("codething:renderer-state:v1");
    const hydrated = hydratePersistedState(
      raw,
      !rawCurrent && raw === rawCodethingV1,
    );
    if (!hydrated) return initialState;

    return { ...hydrated, diffOpen: false };
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
          },
        ],
      };

    case "SYNC_PROJECTS": {
      const previousByCwd = new Map(
        state.projects.map((project) => [project.cwd, project] as const),
      );
      const nextProjects = action.projects.map((project) => {
        const previous = previousByCwd.get(project.cwd);
        return {
          ...project,
          model: resolveModelSlug(previous?.model ?? project.model),
          expanded: previous?.expanded ?? project.expanded,
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
          return {
            ...thread,
            projectId: mappedProjectId,
          };
        })
        .filter((thread): thread is Thread => thread !== null);
      const activeThreadId = nextThreads.some((thread) => thread.id === state.activeThreadId)
        ? state.activeThreadId
        : (nextThreads[0]?.id ?? null);

      return {
        ...state,
        projects: nextProjects,
        threads: nextThreads,
        activeThreadId,
      };
    }

    case "TOGGLE_PROJECT":
      return {
        ...state,
        projects: state.projects.map((p) =>
          p.id === action.projectId ? { ...p, expanded: !p.expanded } : p,
        ),
      };

    case "ADD_THREAD":
      return {
        ...state,
        threads: [
          ...state.threads,
          {
            ...action.thread,
            model: resolveModelSlug(action.thread.model),
            lastVisitedAt: action.thread.lastVisitedAt ?? action.thread.createdAt,
          },
        ],
        activeThreadId: action.thread.id,
      };

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

    case "TOGGLE_DIFF":
      return { ...state, diffOpen: !state.diffOpen };

    case "APPLY_EVENT": {
      const { event, activeAssistantItemRef } = action;
      const target = findThreadBySessionId(state.threads, event.sessionId);
      if (!target) return state;
      if (shouldIgnoreForeignThreadEvent(target, event)) return state;

      return {
        ...state,
        threads: updateThread(state.threads, target.id, (t) => ({
          ...t,
          ...(() => {
            const eventThreadId = getEventThreadId(event);
            const shouldRebindIdentity =
              event.method === "thread/started" && t.session?.status === "connecting";
            return {
              codexThreadId: shouldRebindIdentity
                ? (eventThreadId ?? t.codexThreadId)
                : (t.codexThreadId ?? eventThreadId ?? null),
              error: event.kind === "error" && event.message ? event.message : t.error,
            };
          })(),
          session: t.session ? evolveSession(t.session, event) : t.session,
          messages: applyEventToMessages(t.messages, event, activeAssistantItemRef),
          events: [event, ...t.events],
          ...updateTurnFields(t, event),
          ...(event.method === "turn/completed" && t.id === state.activeThreadId
            ? { lastVisitedAt: event.createdAt }
            : {}),
        })),
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
      return { ...state, threads, activeThreadId };
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
