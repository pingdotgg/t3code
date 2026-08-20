import { describe, expect, it } from "@effect/vitest";

import { createMobileNavigationHistory } from "./mobile-navigation-history";

describe("createMobileNavigationHistory", () => {
  it("moves backward and forward through visited paths", () => {
    const history = createMobileNavigationHistory("/");
    history.visit("/threads/env/thread-a");
    history.visit("/threads/env/thread-b");

    expect(history.back()).toBe("/threads/env/thread-a");
    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: true });

    expect(history.forward()).toBe("/threads/env/thread-b");
    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: false });
  });

  it("drops forward paths after a new visit", () => {
    const history = createMobileNavigationHistory("/");
    history.visit("/threads/env/thread-a");
    history.visit("/threads/env/thread-b");
    history.back();

    history.visit("/settings");

    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: false });
    expect(history.forward()).toBeNull();
  });

  it("recognizes native back navigation", () => {
    const history = createMobileNavigationHistory("/");
    history.visit("/threads/env/thread-a");
    history.visit("/settings");

    history.visit("/threads/env/thread-a");

    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: true });
    expect(history.forward()).toBe("/settings");
  });
});
