import { describe, expect, it } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import type { Store } from "../store.ts";
import type { Row } from "./Sidebar.logic.ts";
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
  projectScopeLabel: "All projects",
  onSearchInput: () => {},
  onFocusSearch: () => {},
  onChooseProjectScope: () => {},
} as const;

describe("Sidebar search box", () => {
  it("renders the wordmark, search, project filter, and Threads header", async () => {
    const t = await testRender(<Sidebar {...baseProps} filter="" searchFocused={false} />, {
      width: 30,
      height: 18,
    });
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("T3");
    expect(frame).toContain("Code");
    expect(frame).toContain("Search threads");
    expect(frame).toContain("All projects");
    expect(frame).toContain("Threads");
    t.renderer.destroy();
  });

  it("shows the active query when a filter is set", async () => {
    const t = await testRender(<Sidebar {...baseProps} filter="parser" searchFocused={false} />, {
      width: 30,
      height: 18,
    });
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
    const row = lines.findIndex((line) => line.includes("Search threads"));
    expect(row).toBeGreaterThanOrEqual(0);
    await t.mockMouse.click(4, row);
    await t.flush();
    expect(focused).toBe(true);
    t.renderer.destroy();
  });
});

describe("Sidebar V2 thread cards", () => {
  it("renders an active thread title with its project on a second line", async () => {
    const rows: Row[] = [
      {
        kind: "thread",
        id: "t1",
        section: "active",
        projectTitle: "Project one",
        timestamp: new Date().toISOString(),
        thread: {
          id: "t1",
          title: "Thread one",
          session: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
        } as never,
      },
    ];
    const t = await testRender(
      <Sidebar
        {...baseProps}
        rows={rows}
        selection={{ kind: "thread", id: "t1" }}
        filter=""
        searchFocused={false}
      />,
      { width: 30, height: 18 },
    );
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("Thread one");
    expect(frame).toContain("Project one");
    t.renderer.destroy();
  });
});
