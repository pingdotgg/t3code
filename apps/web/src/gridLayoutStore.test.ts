import { type EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { resetGridLayoutStoreForTests, useGridLayoutStore } from "./gridLayoutStore";

const ENV_A = "env_a" as EnvironmentId;
const ENV_B = "env_b" as EnvironmentId;

function read(envId: EnvironmentId) {
  return useGridLayoutStore.getState().getState(envId);
}

describe("gridLayoutStore", () => {
  beforeEach(() => {
    resetGridLayoutStoreForTests();
  });

  it("returns a default layout for an unknown environment", () => {
    const state = read(ENV_A);
    expect(state.rows).toBe(2);
    expect(state.cols).toBe(2);
    expect(state.cells).toHaveLength(4);
    expect(state.active).toBe(false);
  });

  it("keeps per-environment state isolated", () => {
    useGridLayoutStore.getState().setSize(ENV_A, 3, 3);
    useGridLayoutStore.getState().setSize(ENV_B, 2, 4);
    expect(read(ENV_A).rows).toBe(3);
    expect(read(ENV_A).cols).toBe(3);
    expect(read(ENV_B).rows).toBe(2);
    expect(read(ENV_B).cols).toBe(4);
  });

  it("assigns and clears cells", () => {
    useGridLayoutStore.getState().assignCell(ENV_A, 1, "env:thread-x");
    expect(read(ENV_A).cells[1]?.threadKey).toBe("env:thread-x");
    useGridLayoutStore.getState().clearCell(ENV_A, 1);
    expect(read(ENV_A).cells[1]?.threadKey).toBeNull();
  });

  it("resizes while preserving cells that fit in the new rectangle", () => {
    useGridLayoutStore.getState().assignCell(ENV_A, 0, "env:t-a");
    useGridLayoutStore.getState().setSize(ENV_A, 3, 3);
    expect(read(ENV_A).cells[0]?.threadKey).toBe("env:t-a");
    expect(read(ENV_A).cells).toHaveLength(9);
  });

  it("tracks active flag", () => {
    useGridLayoutStore.getState().setActive(ENV_A, true);
    const state = read(ENV_A);
    expect(state.active).toBe(true);
  });

  it("tracks last view per environment", () => {
    useGridLayoutStore.getState().setLastView(ENV_A, "grid");
    useGridLayoutStore.getState().setLastView(ENV_B, "thread");
    expect(read(ENV_A).lastView).toBe("grid");
    expect(read(ENV_B).lastView).toBe("thread");
  });

  it("removes a thread from all cells that reference it", () => {
    useGridLayoutStore.getState().assignCell(ENV_A, 0, "env:t-x");
    useGridLayoutStore.getState().assignCell(ENV_A, 2, "env:t-x");
    useGridLayoutStore.getState().assignCell(ENV_A, 3, "env:t-y");
    useGridLayoutStore.getState().removeThread(ENV_A, "env:t-x");
    const state = read(ENV_A);
    expect(state.cells[0]?.threadKey).toBeNull();
    expect(state.cells[2]?.threadKey).toBeNull();
    expect(state.cells[3]?.threadKey).toBe("env:t-y");
  });

  it("clamps requested grid dimensions to bounds", () => {
    useGridLayoutStore.getState().setSize(ENV_A, 99, 0);
    const state = read(ENV_A);
    expect(state.rows).toBe(6);
    expect(state.cols).toBe(1);
    expect(state.cells).toHaveLength(6);
  });

  it("resets an environment to defaults", () => {
    useGridLayoutStore.getState().setSize(ENV_A, 4, 4);
    useGridLayoutStore.getState().assignCell(ENV_A, 5, "env:t-x");
    useGridLayoutStore.getState().resetEnvironment(ENV_A);
    const state = read(ENV_A);
    expect(state.rows).toBe(2);
    expect(state.cols).toBe(2);
    expect(state.cells.every((cell) => cell.threadKey === null)).toBe(true);
  });
});
