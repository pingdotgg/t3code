/**
 * Pure grid-layout logic for the chat-split-grid feature.
 *
 * A grid is an N x M matrix of cells indexed row-major. Each cell references a
 * scoped thread key (populated) or `null` (empty). All functions here are pure
 * reducers — state lives in `gridLayoutStore` and the React tree; this module
 * owns the math.
 */

export const GRID_MIN_DIM = 1;
export const GRID_MAX_DIM = 6;

export interface GridLayoutCell {
  readonly threadKey: string | null;
}

/**
 * Which view this environment was last in. Used on app reopen to restore
 * the user's most-recent context (grid or single-thread) per-environment.
 */
export type LastViewKind = "grid" | "thread" | null;

export interface GridLayoutState {
  readonly rows: number;
  readonly cols: number;
  readonly cells: ReadonlyArray<GridLayoutCell>;
  readonly focusedCellIndex: number;
  readonly active: boolean;
  readonly lastView: LastViewKind;
}

export function createEmptyCells(count: number): GridLayoutCell[] {
  return Array.from({ length: count }, () => ({ threadKey: null }));
}

export function createDefaultGridLayoutState(): GridLayoutState {
  return {
    rows: 2,
    cols: 2,
    cells: createEmptyCells(4),
    focusedCellIndex: 0,
    active: false,
    lastView: null,
  };
}

export function clampGridDim(value: number): number {
  if (!Number.isFinite(value)) return GRID_MIN_DIM;
  return Math.max(GRID_MIN_DIM, Math.min(GRID_MAX_DIM, Math.trunc(value)));
}

/**
 * Resize the grid while preserving populated cells that still fit within the
 * new dimensions. Cells that fall outside the new (rows, cols) rectangle are
 * dropped. Newly introduced cells are empty.
 *
 * Row-major indexing: index = row * oldCols + col.
 */
export function resizeGridLayout(
  state: GridLayoutState,
  nextRows: number,
  nextCols: number,
): GridLayoutState {
  const rows = clampGridDim(nextRows);
  const cols = clampGridDim(nextCols);

  if (rows === state.rows && cols === state.cols) {
    return state;
  }

  const nextCells = createEmptyCells(rows * cols);
  const copyRows = Math.min(rows, state.rows);
  const copyCols = Math.min(cols, state.cols);

  for (let row = 0; row < copyRows; row += 1) {
    for (let col = 0; col < copyCols; col += 1) {
      const oldIndex = row * state.cols + col;
      const newIndex = row * cols + col;
      const sourceCell = state.cells[oldIndex];
      if (sourceCell) {
        nextCells[newIndex] = sourceCell;
      }
    }
  }

  const focusedCellIndex = clampCellIndex(state.focusedCellIndex, rows * cols);

  return {
    ...state,
    rows,
    cols,
    cells: nextCells,
    focusedCellIndex,
  };
}

export function clampCellIndex(index: number, cellCount: number): number {
  if (cellCount <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  const truncated = Math.trunc(index);
  if (truncated < 0) return 0;
  if (truncated >= cellCount) return cellCount - 1;
  return truncated;
}

export function assignCellThread(
  state: GridLayoutState,
  cellIndex: number,
  threadKey: string,
): GridLayoutState {
  const index = clampCellIndex(cellIndex, state.cells.length);
  const existing = state.cells[index];
  if (existing && existing.threadKey === threadKey) {
    return state;
  }
  const cells = state.cells.slice();
  cells[index] = { threadKey };
  return { ...state, cells };
}

export function clearCellThread(state: GridLayoutState, cellIndex: number): GridLayoutState {
  const index = clampCellIndex(cellIndex, state.cells.length);
  const existing = state.cells[index];
  if (!existing || existing.threadKey === null) {
    return state;
  }
  const cells = state.cells.slice();
  cells[index] = { threadKey: null };
  return { ...state, cells };
}

/**
 * Remove a thread key from every cell it appears in. Used when a thread is
 * deleted externally so we don't hold a dangling reference.
 */
export function removeThreadFromGridLayout(
  state: GridLayoutState,
  threadKey: string,
): GridLayoutState {
  let changed = false;
  const cells = state.cells.map((cell) => {
    if (cell.threadKey === threadKey) {
      changed = true;
      return { threadKey: null } satisfies GridLayoutCell;
    }
    return cell;
  });
  return changed ? { ...state, cells } : state;
}

export function setFocusedCell(state: GridLayoutState, cellIndex: number): GridLayoutState {
  const next = clampCellIndex(cellIndex, state.cells.length);
  if (next === state.focusedCellIndex) return state;
  return { ...state, focusedCellIndex: next };
}

export function setGridActive(state: GridLayoutState, active: boolean): GridLayoutState {
  if (state.active === active) return state;
  return { ...state, active };
}

export function setLastView(state: GridLayoutState, lastView: LastViewKind): GridLayoutState {
  if (state.lastView === lastView) return state;
  return { ...state, lastView };
}

/**
 * Returns true if at least one cell holds a thread key.
 */
export function gridHasPopulatedCells(state: GridLayoutState): boolean {
  return state.cells.some((cell) => cell.threadKey !== null);
}

export function populatedCellThreadKeys(state: GridLayoutState): string[] {
  const out: string[] = [];
  for (const cell of state.cells) {
    if (cell.threadKey !== null && !out.includes(cell.threadKey)) {
      out.push(cell.threadKey);
    }
  }
  return out;
}

export function cellIndexToCoord(index: number, cols: number): { row: number; col: number } {
  const row = Math.floor(index / cols);
  const col = index - row * cols;
  return { row, col };
}

export function coordToCellIndex(row: number, col: number, cols: number): number {
  return row * cols + col;
}
