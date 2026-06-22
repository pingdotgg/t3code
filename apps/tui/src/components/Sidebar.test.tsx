import { describe, expect, it } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import type { Store } from "../store.ts";
import { Sidebar } from "./Sidebar.tsx";

// A no-op store — the search box test never triggers the action handlers.
const fakeStore = {} as unknown as Store;

const baseProps = {
  rows: [],
  selection: null,
  moreAbove: false,
  moreBelow: false,
  width: 28,
  height: 16,
  store: fakeStore,
  onSearchInput: () => {},
  onFocusSearch: () => {},
} as const;

describe("Sidebar search box", () => {
  it("renders the wordmark, a search box, and the Projects header", async () => {
    const t = await testRender(
      <Sidebar {...baseProps} filter="" searchFocused={false} />,
      { width: 30, height: 18 },
    );
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("T3");
    expect(frame).toContain("Code");
    expect(frame).toContain("Search projects");
    expect(frame).toContain("Projects");
    t.renderer.destroy();
  });

  it("shows the active query when a filter is set", async () => {
    const t = await testRender(
      <Sidebar {...baseProps} filter="parser" searchFocused={false} />,
      { width: 30, height: 18 },
    );
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("parser");
    t.renderer.destroy();
  });

  it("clicking the search box focuses search (enters filter mode)", async () => {
    let focused = false;
    const t = await testRender(
      <Sidebar
        {...baseProps}
        filter=""
        searchFocused={false}
        onFocusSearch={() => (focused = true)}
      />,
      { width: 30, height: 18 },
    );
    await t.renderOnce();
    await t.flush();
    // Click the row that holds the search placeholder, wherever it landed.
    const lines = t.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Search projects"));
    expect(row).toBeGreaterThanOrEqual(0);
    await t.mockMouse.click(4, row);
    await t.flush();
    expect(focused).toBe(true);
    t.renderer.destroy();
  });
});
