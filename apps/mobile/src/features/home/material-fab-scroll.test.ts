import { describe, expect, it } from "vite-plus/test";

import { updateMaterialFabScroll, type MaterialFabScrollState } from "./material-fab-scroll";

describe("Material FAB scroll direction", () => {
  const initial: MaterialFabScrollState = { anchor: 0, expanded: true };

  it("shrinks scrolling down and expands scrolling up without returning to the top", () => {
    const collapsed = updateMaterialFabScroll(initial, 80, 500);
    expect(collapsed.expanded).toBe(false);
    const lower = updateMaterialFabScroll(collapsed, 180, 500);
    expect(lower.expanded).toBe(false);
    expect(updateMaterialFabScroll(lower, 160, 500).expanded).toBe(true);
  });

  it("accumulates travel but ignores jitter around a direction change", () => {
    let state = updateMaterialFabScroll(initial, 10, 500);
    expect(state.expanded).toBe(true);
    state = updateMaterialFabScroll(state, 14, 500);
    expect(state.expanded).toBe(false);
    state = updateMaterialFabScroll(state, 100, 500);
    state = updateMaterialFabScroll(state, 95, 500);
    state = updateMaterialFabScroll(state, 98, 500);
    expect(state.expanded).toBe(false);
    expect(updateMaterialFabScroll(state, 88, 500).expanded).toBe(true);
  });

  it("does not expand from bottom bounce or collapse from top bounce", () => {
    const bottom = updateMaterialFabScroll(initial, 500, 500);
    const bounce = updateMaterialFabScroll(bottom, 560, 500);
    expect(updateMaterialFabScroll(bounce, 500, 500).expanded).toBe(false);
    expect(updateMaterialFabScroll(initial, -50, 500)).toEqual(initial);
  });

  it("expands near the top and when filtering leaves a non-scrollable list", () => {
    const collapsed = updateMaterialFabScroll(initial, 80, 500);
    expect(updateMaterialFabScroll(collapsed, 5, 500).expanded).toBe(true);
    expect(updateMaterialFabScroll(collapsed, 80, -20)).toEqual(initial);
  });
});
