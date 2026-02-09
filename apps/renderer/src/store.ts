import {
  type Dispatch,
  type ReactNode,
  createContext,
  createElement,
  useContext,
  useEffect,
  useReducer,
} from "react";

import type { ProviderEvent, ProviderSession } from "@acme/contracts";
import { resolveModelSlug } from "./model-logic";
import { hydratePersistedState, toPersistedState } from "./persistenceSchema";
import {
  applyEventToMessages,
  asObject,
  asString,
  evolveSession,
} from "./session-logic";
import {
  DEFAULT_RUNTIME_MODE,
  type Project,
  type RuntimeMode,
  type Thread,
} from "./types";

// ── Actions ──────────────────────────────────────────────────────────

type Action =
  | { type: "ADD_PROJECT"; project: Project }
  | { type: "TOGGLE_PROJECT"; projectId: string }
  | { type: "ADD_THREAD"; thread: Thread }
  | { type: "SET_ACTIVE_THREAD"; threadId: string }
  | { type: "TOGGLE_DIFF" }
  | {
      type: "APPLY_EVENT";
      event: ProviderEvent;
      activeAssistantItemRef: { current: string | null };
    }
  | { type: "UPDATE_SESSION"; threadId: string; session: ProviderSession }
  | { type: "PUSH_USER_MESSAGE"; threadId: string; id: string; text: string }
  | { type: "SET_ERROR"; threadId: string; error: string | null }
  | { type: "SET_THREAD_TITLE"; threadId: string; title: string }
  | { type: "SET_THREAD_MODEL"; threadId: string; model: string }
  | { type: "SET_RUNTIME_MODE"; mode: RuntimeMode };

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  activeThreadId: string | null;
  runtimeMode: RuntimeMode;
  diffOpen: boolean;
}

const PERSISTED_STATE_KEY = "codething:renderer-state:v4";
const LEGACY_PERSISTED_STATE_KEYS = [
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
    const [legacyV3Key, legacyV2Key, legacyV1Key] = LEGACY_PERSISTED_STATE_KEYS;
    const rawLegacyV3 = window.localStorage.getItem(legacyV3Key);
    const rawLegacyV2 = window.localStorage.getItem(legacyV2Key);
    const rawLegacyV1 = window.localStorage.getItem(legacyV1Key);
    const raw = rawCurrent ?? rawLegacyV3 ?? rawLegacyV2 ?? rawLegacyV1;
    if (!raw) return initialState;
    const hydrated = hydratePersistedState(
      raw,
      !rawCurrent && !rawLegacyV3 && !rawLegacyV2 && Boolean(rawLegacyV1),
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
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify(toPersistedState(state)),
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
  return asString(payload?.threadId) ?? asString(asObject(payload?.thread)?.id);
}

function durationMs(startIso: string, endIso: string): number | undefined {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return undefined;
  }

  return end - start;
}

function updateTurnFields(
  thread: Thread,
  event: ProviderEvent,
): Partial<Thread> {
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
      startedAt && startedAt.length > 0
        ? durationMs(startedAt, event.createdAt)
        : undefined;

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
          },
        ],
        activeThreadId: action.thread.id,
      };

    case "SET_ACTIVE_THREAD":
      return { ...state, activeThreadId: action.threadId };

    case "TOGGLE_DIFF":
      return { ...state, diffOpen: !state.diffOpen };

    case "APPLY_EVENT": {
      const { event, activeAssistantItemRef } = action;
      const target = findThreadBySessionId(state.threads, event.sessionId);
      if (!target) return state;

      return {
        ...state,
        threads: updateThread(state.threads, target.id, (t) => ({
          ...t,
          ...(() => {
            const eventThreadId = getEventThreadId(event);
            const hasThreadMismatch =
              t.codexThreadId !== null &&
              eventThreadId !== undefined &&
              eventThreadId !== t.codexThreadId;
            const threadMismatchError = hasThreadMismatch
              ? `Thread identity mismatch: expected ${t.codexThreadId}, received ${eventThreadId}.`
              : null;
            return {
              codexThreadId: t.codexThreadId ?? eventThreadId ?? null,
              error:
                threadMismatchError ??
                (event.kind === "error" && event.message
                  ? event.message
                  : t.error),
            };
          })(),
          session: t.session ? evolveSession(t.session, event) : t.session,
          messages: applyEventToMessages(
            t.messages,
            event,
            activeAssistantItemRef,
          ),
          events: [event, ...t.events],
          ...updateTurnFields(t, event),
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
