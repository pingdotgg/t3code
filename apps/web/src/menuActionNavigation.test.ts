import { describe, expect, it } from "vite-plus/test";

import {
  MENU_ACTION_NAVIGATE_PREFIX,
  resolveMenuActionNavigation,
} from "./menuActionNavigation.ts";

const nav = (target: string) => `${MENU_ACTION_NAVIGATE_PREFIX}${target}`;

describe("MENU_ACTION_NAVIGATE_PREFIX", () => {
  /**
   * The main process declares the same prefix separately, in
   * `apps/desktop/src/app/DesktopUrlRouting.ts`, because this bundle must not
   * import from it and the two are separate TypeScript projects. Both sides pin
   * the literal, so whichever one is edited fails its own test rather than both
   * staying green while deep links quietly stop working.
   */
  it("pins the literal the main process also pins", () => {
    expect(MENU_ACTION_NAVIGATE_PREFIX).toBe("navigate:");
  });
});

describe("resolveMenuActionNavigation", () => {
  it("returns the path of a navigation action", () => {
    expect(resolveMenuActionNavigation(nav("/env-1/thread-1"), "/")).toBe("/env-1/thread-1");
  });

  it("ignores a non-navigation action", () => {
    expect(resolveMenuActionNavigation("open-settings", "/")).toBeNull();
    expect(resolveMenuActionNavigation("", "/")).toBeNull();
  });

  // Navigating to where we already are would push a duplicate history entry and
  // remount the chat for nothing.
  it("ignores a navigation to the current route", () => {
    expect(resolveMenuActionNavigation(nav("/env-1/thread-1"), "/env-1/thread-1")).toBeNull();
  });

  /**
   * The target began life as a URL handed to the app by the operating system,
   * so it is input. A protocol-relative target is the case worth naming: the
   * router reads `//evil.example` as a path, a browser reads it as another
   * origin, and that gap is where an open redirect lives.
   */
  it("refuses anything that is not an absolute in-app path", () => {
    expect(resolveMenuActionNavigation(nav("//evil.example/x"), "/")).toBeNull();
    expect(resolveMenuActionNavigation(nav("https://evil.example"), "/")).toBeNull();
    expect(resolveMenuActionNavigation(nav("env-1/thread-1"), "/")).toBeNull();
    expect(resolveMenuActionNavigation(nav(""), "/")).toBeNull();
  });

  it("keeps a query or fragment the main process chose to send", () => {
    expect(resolveMenuActionNavigation(nav("/env-1/thread-1?tab=files"), "/")).toBe(
      "/env-1/thread-1?tab=files",
    );
  });
});
