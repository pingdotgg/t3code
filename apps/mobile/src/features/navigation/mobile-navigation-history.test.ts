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

    const backTarget = history.backTarget();
    expect(backTarget).toBe("/threads/env/thread-a");
    history.visit(location(backTarget!, "thread-a"), { traversal: true });
    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: true });

    const forwardTarget = history.forwardTarget();
    expect(forwardTarget).toBe("/threads/env/thread-b");
    history.visit(location(forwardTarget!, "thread-b"), { traversal: true });
    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: false });
  });

  it("drops forward paths after a new visit", () => {
    const history = createMobileNavigationHistory(location("/"));
    history.visit(location("/threads/env/thread-a", "thread-a"));
    history.visit(location("/threads/env/thread-b", "thread-b"));
    history.visit(location(history.backTarget()!, "thread-a"), { traversal: true });

    history.visit(location("/settings"));

    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: false });
    expect(history.forwardTarget()).toBeNull();
  });

  it("recognizes native back navigation", () => {
    const history = createMobileNavigationHistory(location("/"));
    history.visit(location("/threads/env/thread-a", "thread-a"));
    history.visit(location("/settings"));

    history.visit(location("/threads/env/thread-a", "thread-a"));

    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: true });
    expect(history.forwardTarget()).toBe("/settings");
  });

  it("reconciles non-adjacent native back navigation without adding a duplicate", () => {
    const history = createMobileNavigationHistory(location("/"));
    history.visit(location("/threads/env/thread-a", "thread-a"));
    history.visit(location("/threads/env/thread-b", "thread-b"));

    history.visit(location("/"));

    expect(history.getSnapshot()).toEqual({ canGoBack: false, canGoForward: true });
    expect(history.forwardTarget()).toBe("/threads/env/thread-a");
  });

  it("records a new visit when an old pathname is selected again", () => {
    const history = createMobileNavigationHistory(location("/"));
    history.visit(location("/threads/env/thread-a", "thread"));
    history.visit(location("/threads/env/thread-b", "thread"));
    history.visit(location("/threads/env/thread-c", "thread"));

    history.visit(location("/threads/env/thread-a", "thread"));

    expect(history.backTarget()).toBe("/threads/env/thread-c");
    expect(history.forwardTarget()).toBeNull();
  });
});
