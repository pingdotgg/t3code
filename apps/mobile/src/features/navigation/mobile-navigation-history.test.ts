import { describe, expect, it } from "@effect/vitest";

import {
  createMobileNavigationHistory,
  normalizeMobileNavigationPath,
} from "./mobile-navigation-history";

describe("createMobileNavigationHistory", () => {
  const location = (pathname: string, transitionKey = pathname) => ({
    pathname,
    transitionKey,
  });

  it("moves backward and forward through visited paths", () => {
    const history = createMobileNavigationHistory(location("/"));
    history.visit(location("/threads/env/thread-a", "thread-a"));
    history.visit(location("/threads/env/thread-b", "thread-b"));
    history.visit(location("/threads/env/thread-b", "thread-b-remount"));
    const backTarget = history.requestBack();
    expect(backTarget?.location.pathname).toBe("/threads/env/thread-a");
    expect(history.requestBack()).toBeNull();
    history.visit(location(backTarget!.location.pathname, "thread-a"));
    expect(history.getSnapshot()).toEqual({ canGoBack: true, canGoForward: true });

    const forwardTarget = history.requestForward();
    expect(forwardTarget?.location.pathname).toBe("/threads/env/thread-b");
    expect(forwardTarget?.location.transitionKey).toBe("thread-b-remount");
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

  it("refreshes recreated nested host keys across forward entries", () => {
    const thread = location("/threads/env/thread-a", "thread-a");
    const history = createMobileNavigationHistory(thread);
    history.visit(location("/settings", "settings-old/content-old/settings-old"));
    history.visit(location("/settings/appearance", "settings-old/content-old/appearance-old"));
    history.visit(thread);
    const forward = history.requestForward()!;
    history.visit(location(forward.location.pathname, "settings-new/content-new/settings-new"));
    expect(history.requestBack()?.location.transitionKey).toBe("thread-a");
    history.cancelPendingTraversal();
    expect(history.requestForward()?.location.transitionKey).toMatch(/^settings-new\//);
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
    history.visit(location("/threads/env/thread/terminal?terminalId=a", "thread"));
    history.visit(location("/threads/env/thread/terminal?terminalId=b", "thread"));
    history.visit(location("/threads/env/thread/terminal?terminalId=c", "thread"));
    history.visit(location("/threads/env/thread/terminal?terminalId=a", "thread"));
    expect(
      normalizeMobileNavigationPath(
        "/settings?params=%5Bobject%20Object%5D&params=keep&state=%5Bobject%20Object%5D&terminalId=a",
      ),
    ).toBe("/settings?params=keep&terminalId=a");
    expect(history.requestBack()?.location.pathname).toContain("terminalId=c");
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

  it("treats a later visit as new after a blocked traversal is cancelled", () => {
    const history = createMobileNavigationHistory(location("/threads/env/thread-a", "thread"));
    history.visit(location("/threads/env/thread-b", "thread"));
    history.visit(location("/threads/env/thread-c", "thread"));

    history.requestBack();
    history.cancelPendingTraversal();
    history.visit(location("/threads/env/thread-b", "thread"));
    expect(history.requestBack()?.location.pathname).toBe("/threads/env/thread-c");
    expect(history.requestForward()).toBeNull();
  });

  it("replaces a cold-start entry without making it a Back target", () => {
    const history = createMobileNavigationHistory(
      location("/threads/env/thread/files", "files-root"),
    );

    expect(history.requestReplacement("/threads/env/thread")).toBe(true);
    history.visit(location("/threads/env/thread", "thread-root"));

    expect(history.getSnapshot()).toEqual({ canGoBack: false, canGoForward: false });
    expect(history.requestBack()).toBeNull();
  });
});
