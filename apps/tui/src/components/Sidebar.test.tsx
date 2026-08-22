import { afterEach, describe, expect, it, jest } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";
import { MouseButtons } from "@opentui/core/testing";

import type { Store } from "../store.ts";
import type { Row } from "./Sidebar.logic.ts";
import { Sidebar, THREAD_CONTEXT_LONG_PRESS_MS } from "./Sidebar.tsx";

// A no-op store — the search box test never triggers the action handlers.
const fakeStore = {} as unknown as Store;

const baseProps = {
  rows: [],
  selection: null,
  width: 28,
  height: 16,
  listHeight: 5,
  store: fakeStore,
  projectScopeLabel: "All projects",
  onSearchInput: () => {},
  onFocusSearch: () => {},
  onChooseProjectScope: () => {},
  onAddProject: () => {},
  onThreadContextMenu: () => {},
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
  afterEach(() => jest.useRealTimers());

  const activeRow = (id: string, title: string): Row => ({
    kind: "thread",
    id,
    section: "active",
    projectTitle: "Project one",
    timestamp: new Date().toISOString(),
    thread: {
      id,
      title,
      branch: "feature/tui",
      session: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
    } as never,
  });

  it("scrolls a selection past the viewport edge into view", async () => {
    const rows: Row[] = Array.from({ length: 12 }, (_, index) =>
      activeRow(`t${index}`, `Thread ${index}`),
    );
    const t = await testRender(
      <Sidebar
        {...baseProps}
        rows={rows}
        selection={{ kind: "thread", id: "t9" }}
        filter=""
        searchFocused={false}
      />,
      { width: 30, height: 18 },
    );
    await t.renderOnce();
    // The deferred scroll lands on the next tick, once layout gave the
    // scrollbox a real content height.
    await new Promise((resolve) => setTimeout(resolve, 1));
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("Thread 9");
    expect(frame).not.toContain("Thread 0");
    t.renderer.destroy();
  });

  it("renders an active thread with project, title, and branch hierarchy", async () => {
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
          branch: "feature/tui",
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
    expect(frame).toContain("feature/tui");
    expect(frame.indexOf("Project one")).toBeLessThan(frame.indexOf("Thread one"));
    expect(frame.indexOf("Thread one")).toBeLessThan(frame.indexOf("feature/tui"));
    t.renderer.destroy();
  });

  it("opens a thread context menu on right-click", async () => {
    const rows = [activeRow("t1", "Thread one")];
    let contextThread = "";
    let selectedThread = "";
    const t = await testRender(
      <Sidebar
        {...baseProps}
        rows={rows}
        selection={null}
        filter=""
        searchFocused={false}
        store={
          {
            select: (selection: { readonly id: string }) => {
              selectedThread = selection.id;
            },
          } as unknown as Store
        }
        onThreadContextMenu={(row) => {
          contextThread = row.id;
        }}
      />,
      { width: 30, height: 18 },
    );
    await t.renderOnce();
    const lines = t.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Thread one"));
    await t.mockMouse.click(6, row, MouseButtons.RIGHT);
    await t.flush();
    expect(contextThread).toBe("t1");
    expect(selectedThread).toBe("");
    t.renderer.destroy();
  });

  it("selects a thread on a short tap without opening its context menu", async () => {
    const rows = [activeRow("t1", "Thread one")];
    let contextThread = "";
    let selectedThread = "";
    const t = await testRender(
      <Sidebar
        {...baseProps}
        rows={rows}
        selection={null}
        filter=""
        searchFocused={false}
        store={
          {
            select: (selection: { readonly id: string }) => {
              selectedThread = selection.id;
            },
          } as unknown as Store
        }
        onThreadContextMenu={(row) => {
          contextThread = row.id;
        }}
      />,
      { width: 30, height: 18 },
    );
    await t.renderOnce();
    await t.flush();
    jest.useFakeTimers();
    const lines = t.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Thread one"));

    await t.mockMouse.pressDown(6, row);
    jest.advanceTimersByTime(THREAD_CONTEXT_LONG_PRESS_MS - 1);
    await t.mockMouse.release(6, row);

    expect(selectedThread).toBe("t1");
    expect(contextThread).toBe("");
    t.renderer.destroy();
  });

  it("opens a thread context menu on long press without selecting it", async () => {
    const rows = [activeRow("t1", "Thread one")];
    let contextThread = "";
    let contextPosition: { readonly x: number; readonly y: number } | null = null;
    let selectedThread = "";
    const t = await testRender(
      <Sidebar
        {...baseProps}
        rows={rows}
        selection={null}
        filter=""
        searchFocused={false}
        store={
          {
            select: (selection: { readonly id: string }) => {
              selectedThread = selection.id;
            },
          } as unknown as Store
        }
        onThreadContextMenu={(row, position) => {
          contextThread = row.id;
          contextPosition = position;
        }}
      />,
      { width: 30, height: 18 },
    );
    await t.renderOnce();
    await t.flush();
    jest.useFakeTimers();
    const lines = t.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Thread one"));

    await t.mockMouse.pressDown(6, row);
    jest.advanceTimersByTime(THREAD_CONTEXT_LONG_PRESS_MS);
    await t.mockMouse.release(6, row);

    expect(contextThread).toBe("t1");
    expect(contextPosition as { readonly x: number; readonly y: number } | null).toEqual({
      x: 6,
      y: row,
    });
    expect(selectedThread).toBe("");
    t.renderer.destroy();
  });
});
