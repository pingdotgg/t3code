import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useBrowserPointerStore } from "./browserPointerStore";

beforeEach(() => {
  useBrowserPointerStore.setState({ byTabId: {} });
});

describe("browserPointerStore", () => {
  it("tracks the latest pointer target independently for each tab", () => {
    const store = useBrowserPointerStore.getState();
    store.apply({
      tabId: "tab_a",
      phase: "move",
      x: 20,
      y: 30,
      sequence: 0,
      createdAt: "2026-06-12T00:00:00.000Z",
    });
    store.apply({
      tabId: "tab_b",
      phase: "move",
      x: 40,
      y: 50,
      sequence: 1,
      createdAt: "2026-06-12T00:00:01.000Z",
    });
    store.apply({
      tabId: "tab_a",
      phase: "click",
      x: 60,
      y: 70,
      sequence: 2,
      createdAt: "2026-06-12T00:00:02.000Z",
    });

    expect(useBrowserPointerStore.getState().byTabId).toMatchObject({
      tab_a: { phase: "click", x: 60, y: 70, sequence: 2 },
      tab_b: { phase: "move", x: 40, y: 50, sequence: 1 },
    });
  });

  it("clears one tab without affecting the others", () => {
    const store = useBrowserPointerStore.getState();
    store.apply({
      tabId: "tab_a",
      phase: "move",
      x: 20,
      y: 30,
      sequence: 0,
      createdAt: "2026-06-12T00:00:00.000Z",
    });
    store.apply({
      tabId: "tab_b",
      phase: "move",
      x: 40,
      y: 50,
      sequence: 1,
      createdAt: "2026-06-12T00:00:01.000Z",
    });

    store.clear("tab_a");

    expect(useBrowserPointerStore.getState().byTabId).toEqual({
      tab_b: expect.objectContaining({ x: 40, y: 50 }),
    });
  });
});
