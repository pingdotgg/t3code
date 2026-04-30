import { describe, expect, it } from "vitest";

import {
  assignCellThread,
  cellIndexToCoord,
  clampCellIndex,
  clampGridDim,
  clearCellThread,
  coordToCellIndex,
  createDefaultGridLayoutState,
  createEmptyCells,
  gridHasPopulatedCells,
  populatedCellThreadKeys,
  removeThreadFromGridLayout,
  resizeGridLayout,
  setFocusedCell,
  setGridActive,
  setLastView,
  GRID_MAX_DIM,
  GRID_MIN_DIM,
} from "./gridLayout";

describe("gridLayout", () => {
  describe("clampGridDim", () => {
    it("clamps below minimum", () => {
      expect(clampGridDim(0)).toBe(GRID_MIN_DIM);
      expect(clampGridDim(-3)).toBe(GRID_MIN_DIM);
    });

    it("clamps above maximum", () => {
      expect(clampGridDim(10)).toBe(GRID_MAX_DIM);
      expect(clampGridDim(7)).toBe(GRID_MAX_DIM);
    });

    it("truncates fractional values", () => {
      expect(clampGridDim(2.9)).toBe(2);
    });

    it("returns minimum for non-finite", () => {
      expect(clampGridDim(Number.NaN)).toBe(GRID_MIN_DIM);
      // POSITIVE_INFINITY is not finite, so falls through the guard and clamps to min.
      expect(clampGridDim(Number.POSITIVE_INFINITY)).toBe(GRID_MIN_DIM);
    });
  });

  describe("createEmptyCells", () => {
    it("creates the requested number of empty cells", () => {
      const cells = createEmptyCells(6);
      expect(cells.length).toBe(6);
      for (const cell of cells) {
        expect(cell.threadKey).toBeNull();
      }
    });

    it("creates unique cell objects (not shared reference)", () => {
      const cells = createEmptyCells(2);
      expect(cells[0]).not.toBe(cells[1]);
    });
  });

  describe("createDefaultGridLayoutState", () => {
    it("defaults to 2x2 with 4 empty cells, focused on index 0", () => {
      const state = createDefaultGridLayoutState();
      expect(state.rows).toBe(2);
      expect(state.cols).toBe(2);
      expect(state.cells.length).toBe(4);
      expect(state.focusedCellIndex).toBe(0);
      expect(state.active).toBe(false);
      expect(state.lastView).toBeNull();
    });
  });

  describe("resizeGridLayout", () => {
    it("returns same state when dimensions unchanged", () => {
      const state = createDefaultGridLayoutState();
      const next = resizeGridLayout(state, 2, 2);
      expect(next).toBe(state);
    });

    it("grows the grid, preserving existing cells at their coordinates", () => {
      const initial = assignCellThread(createDefaultGridLayoutState(), 3, "env:thread-a");
      const next = resizeGridLayout(initial, 3, 3);
      expect(next.rows).toBe(3);
      expect(next.cols).toBe(3);
      expect(next.cells.length).toBe(9);
      // Original cell (1,1) in a 2x2 → index 3; in new 3x3 → index 1*3+1 = 4
      expect(next.cells[4]?.threadKey).toBe("env:thread-a");
      expect(next.cells[3]?.threadKey).toBeNull();
    });

    it("shrinks the grid, dropping cells outside the new rectangle", () => {
      let state = createDefaultGridLayoutState();
      state = resizeGridLayout(state, 3, 3);
      state = assignCellThread(state, 0, "env:thread-a");
      state = assignCellThread(state, 8, "env:thread-b"); // (2,2)
      const next = resizeGridLayout(state, 2, 2);
      expect(next.rows).toBe(2);
      expect(next.cols).toBe(2);
      expect(next.cells.length).toBe(4);
      // (0,0) preserved
      expect(next.cells[0]?.threadKey).toBe("env:thread-a");
      // (2,2) dropped
      for (const cell of next.cells) {
        expect(cell.threadKey).not.toBe("env:thread-b");
      }
    });

    it("clamps focused cell index to fit new cell count", () => {
      let state = createDefaultGridLayoutState();
      state = resizeGridLayout(state, 3, 3);
      state = setFocusedCell(state, 8);
      expect(state.focusedCellIndex).toBe(8);
      const next = resizeGridLayout(state, 2, 2);
      expect(next.focusedCellIndex).toBeLessThan(next.cells.length);
    });

    it("clamps requested dimensions to grid bounds", () => {
      const state = createDefaultGridLayoutState();
      const next = resizeGridLayout(state, 99, 0);
      expect(next.rows).toBe(GRID_MAX_DIM);
      expect(next.cols).toBe(GRID_MIN_DIM);
      expect(next.cells.length).toBe(GRID_MAX_DIM * GRID_MIN_DIM);
    });
  });

  describe("assignCellThread", () => {
    it("sets the thread key on the target cell", () => {
      const state = createDefaultGridLayoutState();
      const next = assignCellThread(state, 2, "env:thread-x");
      expect(next.cells[2]?.threadKey).toBe("env:thread-x");
      expect(next).not.toBe(state);
    });

    it("returns same reference when thread already assigned", () => {
      let state = createDefaultGridLayoutState();
      state = assignCellThread(state, 2, "env:thread-x");
      const next = assignCellThread(state, 2, "env:thread-x");
      expect(next).toBe(state);
    });

    it("clamps out-of-range cell indices", () => {
      const state = createDefaultGridLayoutState();
      const next = assignCellThread(state, 99, "env:thread-x");
      // Clamped to last cell (index 3 in 2x2)
      expect(next.cells[3]?.threadKey).toBe("env:thread-x");
    });
  });

  describe("clearCellThread", () => {
    it("clears a populated cell", () => {
      const populated = assignCellThread(createDefaultGridLayoutState(), 1, "env:thread-x");
      const cleared = clearCellThread(populated, 1);
      expect(cleared.cells[1]?.threadKey).toBeNull();
    });

    it("returns same reference if cell already empty", () => {
      const state = createDefaultGridLayoutState();
      const next = clearCellThread(state, 0);
      expect(next).toBe(state);
    });
  });

  describe("removeThreadFromGridLayout", () => {
    it("removes the thread from every matching cell", () => {
      let state = createDefaultGridLayoutState();
      state = assignCellThread(state, 0, "env:thread-x");
      state = assignCellThread(state, 2, "env:thread-x");
      state = assignCellThread(state, 3, "env:thread-y");
      const next = removeThreadFromGridLayout(state, "env:thread-x");
      expect(next.cells[0]?.threadKey).toBeNull();
      expect(next.cells[2]?.threadKey).toBeNull();
      expect(next.cells[3]?.threadKey).toBe("env:thread-y");
    });

    it("returns same reference when thread key is not present", () => {
      const state = createDefaultGridLayoutState();
      const next = removeThreadFromGridLayout(state, "env:thread-absent");
      expect(next).toBe(state);
    });
  });

  describe("setFocusedCell", () => {
    it("clamps to valid index", () => {
      const state = createDefaultGridLayoutState();
      expect(setFocusedCell(state, -5).focusedCellIndex).toBe(0);
      expect(setFocusedCell(state, 99).focusedCellIndex).toBe(state.cells.length - 1);
    });

    it("returns same reference when unchanged", () => {
      const state = createDefaultGridLayoutState();
      const next = setFocusedCell(state, 0);
      expect(next).toBe(state);
    });
  });

  describe("setGridActive", () => {
    it("toggles active", () => {
      const state = createDefaultGridLayoutState();
      const active = setGridActive(state, true);
      expect(active.active).toBe(true);
      expect(setGridActive(active, true)).toBe(active);
    });
  });

  describe("setLastView", () => {
    it("records the last-active view kind", () => {
      const state = createDefaultGridLayoutState();
      const grid = setLastView(state, "grid");
      expect(grid.lastView).toBe("grid");
      const thread = setLastView(grid, "thread");
      expect(thread.lastView).toBe("thread");
    });

    it("returns same reference when unchanged", () => {
      const state = setLastView(createDefaultGridLayoutState(), "grid");
      expect(setLastView(state, "grid")).toBe(state);
    });
  });

  describe("gridHasPopulatedCells / populatedCellThreadKeys", () => {
    it("returns false/empty for fresh grid", () => {
      const state = createDefaultGridLayoutState();
      expect(gridHasPopulatedCells(state)).toBe(false);
      expect(populatedCellThreadKeys(state)).toEqual([]);
    });

    it("collects unique populated thread keys in order", () => {
      let state = createDefaultGridLayoutState();
      state = assignCellThread(state, 0, "env:thread-a");
      state = assignCellThread(state, 1, "env:thread-b");
      state = assignCellThread(state, 2, "env:thread-a");
      expect(gridHasPopulatedCells(state)).toBe(true);
      expect(populatedCellThreadKeys(state)).toEqual(["env:thread-a", "env:thread-b"]);
    });
  });

  describe("cellIndexToCoord / coordToCellIndex", () => {
    it("round-trips row-major coordinates", () => {
      const cols = 4;
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const index = coordToCellIndex(row, col, cols);
          expect(cellIndexToCoord(index, cols)).toEqual({ row, col });
        }
      }
    });
  });

  describe("clampCellIndex", () => {
    it("handles empty cell lists", () => {
      expect(clampCellIndex(5, 0)).toBe(0);
    });

    it("clamps negative indices to 0", () => {
      expect(clampCellIndex(-3, 5)).toBe(0);
    });

    it("clamps to cellCount - 1", () => {
      expect(clampCellIndex(7, 4)).toBe(3);
    });
  });
});
