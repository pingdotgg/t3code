import { describe, expect, it } from "@effect/vitest";

import { createMobileNavigationHistory } from "./mobile-navigation-history";

describe("createMobileNavigationHistory", () => {
  const location = (pathname: string, transitionKey = pathname) => ({
    pathname,
    transitionKey,
  });

  it("moves backward and forward through visited paths", () => {
    const history = createMobileNavigationHistory(location("/"));
    history.visit(location("/threads/env/thread-a", "thread-a"));
    history.visit(location("/threads/env/thread-b", "thread-b"));

    const backTarget = history.requestBack();
    expect(backTarget?.location.pathname).toBe("/threads/env/thread-a");
    history.visit(location(backTarget!.location.pathname, "thread-a"));
    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: true });

    const forwardTarget = history.requestForward();
    expect(forwardTarget?.location.pathname).toBe("/threads/env/thread-b");
    history.visit(location(forwardTarget!.location.pathname, "thread-b"));
    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: false });
  });

  it("drops forward paths after a new visit", () => {
    const history = createMobileNavigationHistory(location("/"));
    history.visit(location("/threads/env/thread-a", "thread-a"));
    history.visit(location("/threads/env/thread-b", "thread-b"));
    history.visit(history.requestBack()!.location);

    history.visit(location("/settings"));

    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: false });
    expect(history.requestForward()).toBeNull();
  });

  it("recognizes native back navigation", () => {
    const history = createMobileNavigationHistory(location("/"));
    history.visit(location("/threads/env/thread-a", "thread-a"));
    history.visit(location("/settings"));

    history.visit(location("/threads/env/thread-a", "thread-a"));

    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: true });
    expect(history.requestForward()?.location.pathname).toBe("/settings");
  });

  it("reconciles non-adjacent native back navigation without adding a duplicate", () => {
    const history = createMobileNavigationHistory(location("/"));
    history.visit(location("/threads/env/thread-a", "thread-a"));
    history.visit(location("/threads/env/thread-b", "thread-b"));

    history.visit(location("/"));

    expect(history.getSnapshot()).toEqual({ canGoBack: false, canGoForward: true });
    expect(history.requestForward()?.location.pathname).toBe("/threads/env/thread-a");
  });

  it("records a new visit when an old pathname is selected again", () => {
    const history = createMobileNavigationHistory(location("/"));
    history.visit(location("/threads/env/thread-a", "thread"));
    history.visit(location("/threads/env/thread-b", "thread"));
    history.visit(location("/threads/env/thread-c", "thread"));

    history.visit(location("/threads/env/thread-a", "thread"));

    expect(history.requestBack()?.location.pathname).toBe("/threads/env/thread-c");
    expect(history.requestForward()).toBeNull();
  });

  it("distinguishes identical Back and Forward pathnames by target index", () => {
    const history = createMobileNavigationHistory(location("/threads/env/thread-a", "a-1"));
    history.visit(location("/threads/env/thread-b", "b"));
    history.visit(location("/threads/env/thread-a", "a-2"));
    history.visit(history.requestBack()!.location);

    const forward = history.requestForward();
    expect(forward).toEqual({
      direction: "forward",
      index: 2,
      location: location("/threads/env/thread-a", "a-2"),
    });
    history.visit(forward!.location);

    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: false });
  });
});
