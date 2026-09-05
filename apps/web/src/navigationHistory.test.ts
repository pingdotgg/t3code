import { createMemoryHistory, type RouterHistory } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createNavigationHistory, registerNavigationHistory } from "./navigationHistoryStore";

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

function withRouterLocationKey(
  history: RouterHistory,
  pathname: string,
  key: string,
): RouterHistory {
  const locationWithKey = (location: RouterHistory["location"]): RouterHistory["location"] =>
    location.pathname === pathname
      ? { ...location, state: { ...location.state, __TSR_key: key } }
      : location;

  return {
    ...history,
    get location() {
      return locationWithKey(history.location);
    },
    subscribe: (listener) =>
      history.subscribe(({ action, location }) =>
        listener({ action, location: locationWithKey(location) }),
      ),
  };
}

afterEach(() => vi.unstubAllGlobals());

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

  it("restores forward availability after reloading a previous entry", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });

    const firstRouterHistory = createMemoryHistory({ initialEntries: ["/", "/thread-a"] });
    const firstHistory = registerNavigationHistory(firstRouterHistory);
    firstRouterHistory.push("/thread-b");
    firstHistory.back();
    const restoredKey = firstRouterHistory.location.state.__TSR_key;
    expect(firstHistory.getSnapshot()).toEqual({ canGoBack: true, canGoForward: true });
    expect(restoredKey).toBeTypeOf("string");

    const reloadedRouterHistory = createMemoryHistory({
      initialEntries: ["/", "/thread-a", "/thread-b"],
      initialIndex: 1,
    });
    const reloadedHistory = withRouterLocationKey(reloadedRouterHistory, "/thread-a", restoredKey!);
    const restoredHistory = registerNavigationHistory(reloadedHistory);

    expect(restoredHistory.getSnapshot()).toEqual({ canGoBack: true, canGoForward: true });
    restoredHistory.forward();
    expect(reloadedRouterHistory.location.pathname).toBe("/thread-b");
    expect(restoredHistory.getSnapshot()).toEqual({ canGoBack: true, canGoForward: false });
  });
});
