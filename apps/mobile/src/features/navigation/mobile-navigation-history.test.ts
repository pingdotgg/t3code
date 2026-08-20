import { describe, expect, it } from "@effect/vitest";

import { createMobileNavigationHistory } from "./mobile-navigation-history";

describe("createMobileNavigationHistory", () => {
  it("moves backward and forward through visited paths", () => {
    const history = createMobileNavigationHistory("/");
    history.visit("/threads/env/thread-a");
    history.visit("/threads/env/thread-b");

    const backTarget = history.backTarget();
    expect(backTarget).toBe("/threads/env/thread-a");
    history.visit(backTarget!);
    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: true });

    const forwardTarget = history.forwardTarget();
    expect(forwardTarget).toBe("/threads/env/thread-b");
    history.visit(forwardTarget!);
    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: false });
  });

  it("drops forward paths after a new visit", () => {
    const history = createMobileNavigationHistory("/");
    history.visit("/threads/env/thread-a");
    history.visit("/threads/env/thread-b");
    history.visit(history.backTarget()!);

    history.visit("/settings");

    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: false });
    expect(history.forwardTarget()).toBeNull();
  });

  it("recognizes native back navigation", () => {
    const history = createMobileNavigationHistory("/");
    history.visit("/threads/env/thread-a");
    history.visit("/settings");

    history.visit("/threads/env/thread-a");

    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: true });
    expect(history.forwardTarget()).toBe("/settings");
  });

  it("reconciles non-adjacent native back navigation without adding a duplicate", () => {
    const history = createMobileNavigationHistory("/");
    history.visit("/threads/env/thread-a");
    history.visit("/threads/env/thread-b");

    history.visit("/");

    expect(history.getSnapshot()).toEqual({ canGoBack: false, canGoForward: true });
    expect(history.forwardTarget()).toBe("/threads/env/thread-a");
  });
});
