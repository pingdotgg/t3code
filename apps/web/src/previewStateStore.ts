import type { PreviewControlValueMap, PreviewViewportPreset } from "@forma/contracts";
import { create } from "zustand";

const PREVIEW_PERSISTED_STATE_KEY = "forma:preview-state:v1";

export type PreviewViewportMode = "auto" | PreviewViewportPreset | "responsive";

export interface PreviewThreadUiState {
  readonly selectedPreviewId: string | null;
  readonly selectedCaseByPreviewId: Record<string, string>;
  readonly selectedControlValuesByPreviewId: Record<string, PreviewControlValueMap>;
  readonly pinned: boolean;
  readonly viewportMode: PreviewViewportMode;
}

interface PersistedPreviewState {
  readonly byThreadKey?: Record<string, PreviewThreadUiState>;
}

interface PreviewStateStore {
  readonly byThreadKey: Record<string, PreviewThreadUiState>;
  readonly setSelectedPreview: (threadKey: string, previewId: string | null) => void;
  readonly setSelectedCase: (threadKey: string, previewId: string, caseId: string) => void;
  readonly setControlValues: (
    threadKey: string,
    previewId: string,
    controlValues: PreviewControlValueMap,
  ) => void;
  readonly setPinned: (threadKey: string, pinned: boolean) => void;
  readonly setViewportMode: (threadKey: string, viewportMode: PreviewViewportMode) => void;
}

const DEFAULT_THREAD_STATE: PreviewThreadUiState = {
  selectedPreviewId: null,
  selectedCaseByPreviewId: {},
  selectedControlValuesByPreviewId: {},
  pinned: false,
  viewportMode: "auto",
};

function sanitizeControlValueMap(value: unknown): PreviewControlValueMap {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([controlId, controlValue]) => {
      if (typeof controlId !== "string" || controlId.length === 0) {
        return [];
      }
      if (
        typeof controlValue === "string" ||
        typeof controlValue === "number" ||
        typeof controlValue === "boolean"
      ) {
        return [[controlId, controlValue]];
      }
      return [];
    }),
  );
}

function sanitizeThreadState(value: unknown): PreviewThreadUiState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const selectedCaseByPreviewId =
    record.selectedCaseByPreviewId && typeof record.selectedCaseByPreviewId === "object"
      ? Object.fromEntries(
          Object.entries(record.selectedCaseByPreviewId as Record<string, unknown>).flatMap(
            ([previewId, caseId]) =>
              typeof previewId === "string" &&
              previewId.length > 0 &&
              typeof caseId === "string" &&
              caseId.length > 0
                ? [[previewId, caseId]]
                : [],
          ),
        )
      : {};
  const selectedControlValuesByPreviewId =
    record.selectedControlValuesByPreviewId &&
    typeof record.selectedControlValuesByPreviewId === "object"
      ? Object.fromEntries(
          Object.entries(
            record.selectedControlValuesByPreviewId as Record<string, unknown>,
          ).flatMap(([previewId, controlValues]) =>
            typeof previewId === "string" && previewId.length > 0
              ? [[previewId, sanitizeControlValueMap(controlValues)]]
              : [],
          ),
        )
      : {};
  const viewportMode =
    record.viewportMode === "auto" ||
    record.viewportMode === "responsive" ||
    record.viewportMode === "sm" ||
    record.viewportMode === "md" ||
    record.viewportMode === "lg" ||
    record.viewportMode === "xl"
      ? record.viewportMode
      : "auto";

  return {
    selectedPreviewId:
      typeof record.selectedPreviewId === "string" && record.selectedPreviewId.length > 0
        ? record.selectedPreviewId
        : null,
    selectedCaseByPreviewId,
    selectedControlValuesByPreviewId,
    pinned: record.pinned === true,
    viewportMode,
  };
}

function readPersistedPreviewState(): Record<string, PreviewThreadUiState> {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const rawValue = window.localStorage.getItem(PREVIEW_PERSISTED_STATE_KEY);
    if (!rawValue) {
      return {};
    }
    const parsed = JSON.parse(rawValue) as PersistedPreviewState;
    if (!parsed.byThreadKey || typeof parsed.byThreadKey !== "object") {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed.byThreadKey).flatMap(([threadKey, threadState]) => {
        if (typeof threadKey !== "string" || threadKey.length === 0) {
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

function persistPreviewState(state: Record<string, PreviewThreadUiState>): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      PREVIEW_PERSISTED_STATE_KEY,
      JSON.stringify({
        byThreadKey: state,
      } satisfies PersistedPreviewState),
    );
  } catch {
    // Ignore storage failures to avoid breaking chat UX.
  }
}

function threadStateFor(
  state: Record<string, PreviewThreadUiState>,
  threadKey: string,
): PreviewThreadUiState {
  return state[threadKey] ?? DEFAULT_THREAD_STATE;
}

export const usePreviewStateStore = create<PreviewStateStore>()((set) => ({
  byThreadKey: readPersistedPreviewState(),
  setSelectedPreview: (threadKey, previewId) =>
    set((state) => {
      const nextState = {
        ...state.byThreadKey,
        [threadKey]: {
          ...threadStateFor(state.byThreadKey, threadKey),
          selectedPreviewId: previewId,
        },
      };
      persistPreviewState(nextState);
      return { byThreadKey: nextState };
    }),
  setSelectedCase: (threadKey, previewId, caseId) =>
    set((state) => {
      const currentThreadState = threadStateFor(state.byThreadKey, threadKey);
      const nextState = {
        ...state.byThreadKey,
        [threadKey]: {
          ...currentThreadState,
          selectedCaseByPreviewId: {
            ...currentThreadState.selectedCaseByPreviewId,
            [previewId]: caseId,
          },
        },
      };
      persistPreviewState(nextState);
      return { byThreadKey: nextState };
    }),
  setControlValues: (threadKey, previewId, controlValues) =>
    set((state) => {
      const currentThreadState = threadStateFor(state.byThreadKey, threadKey);
      const nextState = {
        ...state.byThreadKey,
        [threadKey]: {
          ...currentThreadState,
          selectedControlValuesByPreviewId: {
            ...currentThreadState.selectedControlValuesByPreviewId,
            [previewId]: controlValues,
          },
        },
      };
      persistPreviewState(nextState);
      return { byThreadKey: nextState };
    }),
  setPinned: (threadKey, pinned) =>
    set((state) => {
      const nextState = {
        ...state.byThreadKey,
        [threadKey]: {
          ...threadStateFor(state.byThreadKey, threadKey),
          pinned,
        },
      };
      persistPreviewState(nextState);
      return { byThreadKey: nextState };
    }),
  setViewportMode: (threadKey, viewportMode) =>
    set((state) => {
      const nextState = {
        ...state.byThreadKey,
        [threadKey]: {
          ...threadStateFor(state.byThreadKey, threadKey),
          viewportMode,
        },
      };
      persistPreviewState(nextState);
      return { byThreadKey: nextState };
    }),
}));
