import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { createNavigationHistory } from "./navigationHistoryStore";

describe("createNavigationHistory", () => {
  it("tracks back and forward availability through navigation", () => {
    const routerHistory = createMemoryHistory({ initialEntries: ["/"] });
    const history = createNavigationHistory(routerHistory);
    const unsubscribe = history.subscribe(() => undefined);

    expect(history.getSnapshot()).toEqual({ canGoBack: false, canGoForward: false });

    routerHistory.push("/thread-a");
    routerHistory.push("/thread-b");
    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: false });

    history.back();
    expect(routerHistory.location.pathname).toBe("/thread-a");
    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: true });

    history.forward();
    expect(routerHistory.location.pathname).toBe("/thread-b");
    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: false });
    unsubscribe();
  });

  it("drops the forward path after navigating somewhere new", () => {
    const routerHistory = createMemoryHistory({ initialEntries: ["/"] });
    const history = createNavigationHistory(routerHistory);
    const unsubscribe = history.subscribe(() => undefined);

    routerHistory.push("/thread-a");
    routerHistory.push("/thread-b");
    history.back();
    expect(history.getSnapshot().canGoForward).toBe(true);

    routerHistory.push("/settings/general");
    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: false });
    history.forward();
    expect(routerHistory.location.pathname).toBe("/settings/general");
    unsubscribe();
  });

  it("notifies subscribers only when availability changes", () => {
    const routerHistory = createMemoryHistory({ initialEntries: ["/"] });
    const history = createNavigationHistory(routerHistory);
    const snapshots: Array<ReturnType<typeof history.getSnapshot>> = [];
    const unsubscribe = history.subscribe(() => snapshots.push(history.getSnapshot()));

    routerHistory.replace("/?tab=all");
    routerHistory.push("/thread-a");
    routerHistory.push("/thread-b");
    history.back();

    expect(snapshots).toEqual([
      { canGoBack: true, canGoForward: false },
      { canGoBack: true, canGoForward: true },
    ]);

    unsubscribe();
  });
});
