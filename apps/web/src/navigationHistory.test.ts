import { createMemoryHistory, type RouterHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { createNavigationHistory } from "./navigationHistoryStore";

function withoutRouterLocationState(history: RouterHistory): RouterHistory {
  return {
    ...history,
    get location() {
      return { ...history.location, state: {} as RouterHistory["location"]["state"] };
    },
    subscribe: (listener) =>
      history.subscribe(({ action, location }) =>
        listener({
          action,
          location: { ...location, state: {} as RouterHistory["location"]["state"] },
        }),
      ),
  };
}

describe("createNavigationHistory", () => {
  it("tracks back and forward availability through navigation", () => {
    const routerHistory = createMemoryHistory({ initialEntries: ["/"] });
    const history = createNavigationHistory(withoutRouterLocationState(routerHistory));
    const snapshots: Array<ReturnType<typeof history.getSnapshot>> = [];
    history.subscribe(() => snapshots.push(history.getSnapshot()));
    history.start();
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

    history.back();
    routerHistory.push("/settings/general");
    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: false });
    history.forward();
    expect(routerHistory.location.pathname).toBe("/settings/general");
    expect(snapshots).toEqual([
      { canGoBack: true, canGoForward: false },
      { canGoBack: true, canGoForward: true },
      { canGoBack: true, canGoForward: false },
      { canGoBack: true, canGoForward: true },
      { canGoBack: true, canGoForward: false },
    ]);

    const restored = createNavigationHistory(
      createMemoryHistory({ initialEntries: ["/", "/thread-a"] }),
    );
    expect(restored.getSnapshot().canGoBack).toBe(true);
  });
});
