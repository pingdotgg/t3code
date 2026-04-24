import { parseScopedThreadKey } from "@forma/client-runtime";
import { create } from "zustand";

import { DEFAULT_THREAD_PREVIEW_HEIGHT } from "./types";

const BOTTOM_PANEL_PERSISTED_STATE_KEY = "forma:bottom-panel-state:v1";

export type BottomPanelMode = "closed" | "terminal" | "preview";

export interface ThreadBottomPanelState {
  readonly mode: BottomPanelMode;
  readonly previewHeight: number;
}

interface PersistedBottomPanelState {
  readonly byThreadKey?: Record<string, ThreadBottomPanelState>;
}

interface BottomPanelStateStore {
  readonly byThreadKey: Record<string, ThreadBottomPanelState>;
  readonly setMode: (threadKey: string, mode: BottomPanelMode) => void;
  readonly setPreviewHeight: (threadKey: string, previewHeight: number) => void;
}

const DEFAULT_THREAD_BOTTOM_PANEL_STATE: ThreadBottomPanelState = {
  mode: "closed",
  previewHeight: DEFAULT_THREAD_PREVIEW_HEIGHT,
};

function sanitizeThreadState(value: unknown): ThreadBottomPanelState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    mode:
      record.mode === "closed" || record.mode === "terminal" || record.mode === "preview"
        ? record.mode
        : "closed",
    previewHeight:
      typeof record.previewHeight === "number" && Number.isFinite(record.previewHeight)
        ? Math.max(1, Math.round(record.previewHeight))
        : DEFAULT_THREAD_PREVIEW_HEIGHT,
  };
}

function readPersistedBottomPanelState(): Record<string, ThreadBottomPanelState> {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const rawValue = window.localStorage.getItem(BOTTOM_PANEL_PERSISTED_STATE_KEY);
    if (!rawValue) {
      return {};
    }
    const parsed = JSON.parse(rawValue) as PersistedBottomPanelState;
    if (!parsed.byThreadKey || typeof parsed.byThreadKey !== "object") {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed.byThreadKey).flatMap(([threadKey, threadState]) => {
        if (!parseScopedThreadKey(threadKey)) {
          return [];
        }
        const sanitized = sanitizeThreadState(threadState);
        return sanitized ? [[threadKey, sanitized]] : [];
      }),
    );
  } catch {
    return {};
  }
}

function persistBottomPanelState(state: Record<string, ThreadBottomPanelState>): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      BOTTOM_PANEL_PERSISTED_STATE_KEY,
      JSON.stringify({
        byThreadKey: state,
      } satisfies PersistedBottomPanelState),
    );
  } catch {
    // Ignore storage failures to avoid breaking chat UX.
  }
}

function threadStateFor(
  state: Record<string, ThreadBottomPanelState>,
  threadKey: string,
): ThreadBottomPanelState {
  return state[threadKey] ?? DEFAULT_THREAD_BOTTOM_PANEL_STATE;
}

function isDefaultThreadBottomPanelState(state: ThreadBottomPanelState): boolean {
  return (
    state.mode === DEFAULT_THREAD_BOTTOM_PANEL_STATE.mode &&
    state.previewHeight === DEFAULT_THREAD_BOTTOM_PANEL_STATE.previewHeight
  );
}

function updateThreadState(
  state: Record<string, ThreadBottomPanelState>,
  threadKey: string,
  updater: (current: ThreadBottomPanelState) => ThreadBottomPanelState,
): Record<string, ThreadBottomPanelState> {
  const currentState = threadStateFor(state, threadKey);
  const nextThreadState = updater(currentState);
  if (
    nextThreadState.mode === currentState.mode &&
    nextThreadState.previewHeight === currentState.previewHeight
  ) {
    return state;
  }

  if (isDefaultThreadBottomPanelState(nextThreadState)) {
    if (state[threadKey] === undefined) {
      return state;
    }
    const { [threadKey]: _removed, ...rest } = state;
    return rest;
  }

  return {
    ...state,
    [threadKey]: nextThreadState,
  };
}

export function selectThreadBottomPanelState(
  byThreadKey: Record<string, ThreadBottomPanelState>,
  threadKey: string | null | undefined,
): ThreadBottomPanelState {
  if (!threadKey || !parseScopedThreadKey(threadKey)) {
    return DEFAULT_THREAD_BOTTOM_PANEL_STATE;
  }
  return byThreadKey[threadKey] ?? DEFAULT_THREAD_BOTTOM_PANEL_STATE;
}

export const useBottomPanelStateStore = create<BottomPanelStateStore>()((set) => ({
  byThreadKey: readPersistedBottomPanelState(),
  setMode: (threadKey, mode) =>
    set((state) => {
      const nextState = updateThreadState(state.byThreadKey, threadKey, (current) => ({
        ...current,
        mode,
      }));
      persistBottomPanelState(nextState);
      return nextState === state.byThreadKey ? state : { byThreadKey: nextState };
    }),
  setPreviewHeight: (threadKey, previewHeight) =>
    set((state) => {
      const nextState = updateThreadState(state.byThreadKey, threadKey, (current) => ({
        ...current,
        previewHeight: Math.max(1, Math.round(previewHeight)),
      }));
      persistBottomPanelState(nextState);
      return nextState === state.byThreadKey ? state : { byThreadKey: nextState };
    }),
}));
