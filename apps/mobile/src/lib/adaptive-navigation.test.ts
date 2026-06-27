import { describe, expect, it } from "vite-plus/test";

import {
  isBaseThreadRoute,
  resolveFileSelectionNavigationAction,
  resolveThreadSelectionNavigationAction,
} from "./adaptive-navigation";

describe("isBaseThreadRoute", () => {
  it("recognizes only the thread detail route", () => {
    expect(isBaseThreadRoute("/threads/environment/thread")).toBe(true);
    expect(isBaseThreadRoute("/threads/environment/thread/")).toBe(true);
    expect(isBaseThreadRoute("/threads/environment/thread/files")).toBe(false);
    expect(isBaseThreadRoute("/threads/environment/thread/review")).toBe(false);
  });
});

describe("resolveThreadSelectionNavigationAction", () => {
  it("updates params when a persistent sidebar selects a peer thread", () => {
    expect(
      resolveThreadSelectionNavigationAction({
        usesSplitView: true,
        pathname: "/threads/environment/thread",
      }),
    ).toBe("set-params");
  });

  it("replaces nested thread content when a persistent sidebar selects a peer", () => {
    expect(
      resolveThreadSelectionNavigationAction({
        usesSplitView: true,
        pathname: "/threads/environment/thread/files/path",
      }),
    ).toBe("replace");
  });

  it("pushes compact list selections onto the native stack", () => {
    expect(
      resolveThreadSelectionNavigationAction({
        usesSplitView: false,
        pathname: "/threads/environment/thread",
      }),
    ).toBe("push");
  });
});

describe("resolveFileSelectionNavigationAction", () => {
  it("replaces the wide file browser with the selected preview", () => {
    expect(resolveFileSelectionNavigationAction({ hasPersistentFileInspector: true })).toBe(
      "replace",
    );
  });

  it("pushes a preview above the compact file browser", () => {
    expect(resolveFileSelectionNavigationAction({ hasPersistentFileInspector: false })).toBe(
      "push",
    );
  });
});
