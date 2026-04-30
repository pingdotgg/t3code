/**
 * Zustand store for the chat-split-grid feature.
 *
 * Holds per-environment grid layouts persisted to localStorage. The grid is a
 * separate view mode: when a user enters grid mode for an environment, we
 * render an N x M matrix of panes, each bound to its own thread.
 *
 * Per-env isolation: each environment gets its own layout so switching
 * projects doesn't blow away the grid configuration of the one you left.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  assignCellThread,
  clampCellIndex,
  clearCellThread,
  createDefaultGridLayoutState,
  createEmptyCells,
  GRID_MAX_DIM,
  GRID_MIN_DIM,
  gridHasPopulatedCells,
  type GridLayoutCell,
  type GridLayoutState,
  type LastViewKind,
  populatedCellThreadKeys,
  removeThreadFromGridLayout,
  resizeGridLayout,
  setFocusedCell,
  setGridActive,
  setLastView as setLastViewOnState,
} from "./components/grid/gridLayout";

export const GRID_LAYOUT_STORAGE_KEY = "t3code:grid-layout:v1";

const GridLayoutCellSchema = Schema.Struct({
  threadKey: Schema.NullOr(Schema.String),
});

const LastViewSchema = Schema.NullOr(
  Schema.Union([Schema.Literal("grid"), Schema.Literal("thread")]),
);

const GridLayoutStateSchema = Schema.Struct({
  rows: Schema.Number,
  cols: Schema.Number,
  cells: Schema.Array(GridLayoutCellSchema),
  focusedCellIndex: Schema.Number,
  active: Schema.Boolean,
  lastView: LastViewSchema,
});

const PersistedGridLayoutDocumentSchema = Schema.Struct({
  version: Schema.Literal(1),
  stateByEnvironmentId: Schema.Record(Schema.String, GridLayoutStateSchema),
});
type PersistedGridLayoutDocument = typeof PersistedGridLayoutDocumentSchema.Type;

interface GridLayoutStoreState {
  stateByEnvironmentId: Record<string, GridLayoutState>;
}

interface GridLayoutStoreActions {
  getState: (environmentId: EnvironmentId) => GridLayoutState;
  setActive: (environmentId: EnvironmentId, active: boolean) => void;
  setSize: (environmentId: EnvironmentId, rows: number, cols: number) => void;
  assignCell: (environmentId: EnvironmentId, cellIndex: number, threadKey: string) => void;
  clearCell: (environmentId: EnvironmentId, cellIndex: number) => void;
  setFocusedCell: (environmentId: EnvironmentId, cellIndex: number) => void;
  setLastView: (environmentId: EnvironmentId, view: LastViewKind) => void;
  removeThread: (environmentId: EnvironmentId, threadKey: string) => void;
  resetEnvironment: (environmentId: EnvironmentId) => void;
}

export type GridLayoutStore = GridLayoutStoreState & GridLayoutStoreActions;

function normalizeEnvState(raw: unknown): GridLayoutState {
  if (!raw || typeof raw !== "object") {
    return createDefaultGridLayoutState();
  }
  const candidate = raw as Partial<GridLayoutState>;
  const rows = clampDim(candidate.rows);
  const cols = clampDim(candidate.cols);
  const cellCount = rows * cols;
  const rawCells = Array.isArray(candidate.cells) ? candidate.cells : [];
  const cells: GridLayoutCell[] = createEmptyCells(cellCount);
  for (let i = 0; i < cellCount; i += 1) {
    const cell = rawCells[i];
    const threadKey =
      cell && typeof cell === "object" && typeof cell.threadKey === "string" && cell.threadKey
        ? cell.threadKey
        : null;
    cells[i] = { threadKey };
  }
  const focusedCellIndex = clampCellIndex(candidate.focusedCellIndex ?? 0, cellCount);
  const rawLastView = (candidate as { lastView?: unknown }).lastView;
  const lastView: LastViewKind =
    rawLastView === "grid" || rawLastView === "thread" ? rawLastView : null;
  return {
    rows,
    cols,
    cells,
    focusedCellIndex,
    active: Boolean(candidate.active),
    lastView,
  };
}

function clampDim(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 2;
  const truncated = Math.trunc(value);
  if (truncated < GRID_MIN_DIM) return GRID_MIN_DIM;
  if (truncated > GRID_MAX_DIM) return GRID_MAX_DIM;
  return truncated;
}

function getOrInit(state: GridLayoutStoreState, environmentId: EnvironmentId): GridLayoutState {
  return state.stateByEnvironmentId[environmentId] ?? createDefaultGridLayoutState();
}

function patch(
  state: GridLayoutStoreState,
  environmentId: EnvironmentId,
  next: GridLayoutState,
): GridLayoutStoreState {
  const prev = state.stateByEnvironmentId[environmentId];
  if (prev && prev === next) return state;
  return {
    stateByEnvironmentId: {
      ...state.stateByEnvironmentId,
      [environmentId]: next,
    },
  };
}

export const useGridLayoutStore = create<GridLayoutStore>()(
  persist(
    (set, get) => ({
      stateByEnvironmentId: {},
      getState: (environmentId) => getOrInit(get(), environmentId),
      setActive: (environmentId, active) => {
        set((state) =>
          patch(state, environmentId, setGridActive(getOrInit(state, environmentId), active)),
        );
      },
      setSize: (environmentId, rows, cols) => {
        set((state) =>
          patch(
            state,
            environmentId,
            resizeGridLayout(getOrInit(state, environmentId), rows, cols),
          ),
        );
      },
      assignCell: (environmentId, cellIndex, threadKey) => {
        set((state) =>
          patch(
            state,
            environmentId,
            assignCellThread(getOrInit(state, environmentId), cellIndex, threadKey),
          ),
        );
      },
      clearCell: (environmentId, cellIndex) => {
        set((state) =>
          patch(state, environmentId, clearCellThread(getOrInit(state, environmentId), cellIndex)),
        );
      },
      setFocusedCell: (environmentId, cellIndex) => {
        set((state) =>
          patch(state, environmentId, setFocusedCell(getOrInit(state, environmentId), cellIndex)),
        );
      },
      setLastView: (environmentId, view) => {
        set((state) =>
          patch(state, environmentId, setLastViewOnState(getOrInit(state, environmentId), view)),
        );
      },
      removeThread: (environmentId, threadKey) => {
        set((state) =>
          patch(
            state,
            environmentId,
            removeThreadFromGridLayout(getOrInit(state, environmentId), threadKey),
          ),
        );
      },
      resetEnvironment: (environmentId) => {
        set((state) => patch(state, environmentId, createDefaultGridLayoutState()));
      },
    }),
    {
      name: GRID_LAYOUT_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        typeof window === "undefined"
          ? {
              getItem: () => null,
              setItem: () => undefined,
              removeItem: () => undefined,
            }
          : window.localStorage,
      ),
      partialize: (state) => ({ stateByEnvironmentId: state.stateByEnvironmentId }),
      merge: (persisted, current) => {
        if (!persisted || typeof persisted !== "object") return current;
        const candidate = persisted as Partial<PersistedGridLayoutDocument> & {
          stateByEnvironmentId?: Record<string, unknown>;
        };
        const mapping = candidate.stateByEnvironmentId ?? {};
        const restored: Record<string, GridLayoutState> = {};
        for (const [envId, raw] of Object.entries(mapping)) {
          restored[envId] = normalizeEnvState(raw);
        }
        return { ...current, stateByEnvironmentId: restored };
      },
    },
  ),
);

/**
 * Standalone test hook for resetting the store between tests.
 */
export function resetGridLayoutStoreForTests(): void {
  useGridLayoutStore.setState({ stateByEnvironmentId: {} });
}

export { gridHasPopulatedCells, populatedCellThreadKeys };
