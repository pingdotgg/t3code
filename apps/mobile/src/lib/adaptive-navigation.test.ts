import { describe, expect, it } from "vite-plus/test";

import {
  isBaseThreadRoute,
  resolveFileSelectionNavigationAction,
  resolveThreadSelectionNavigationAction,
  parseActiveTaskPath,
  resolveTaskSelectionNavigationAction,
} from "./adaptive-navigation";

describe("task navigation", () => {
  it("preserves scoped task selection through task-only and legacy tool routes", () => {
    expect(parseActiveTaskPath("/tasks/environment/task")).toEqual({
      environmentId: "environment",
      taskId: "task",
    });
    expect(parseActiveTaskPath("/threads/environment/files?taskId=task")).toEqual({
      environmentId: "environment",
      taskId: "task",
    });
    expect(parseActiveTaskPath("/threads/environment/thread/terminal?taskId=task")).toEqual({
      environmentId: "environment",
      taskId: "task",
    });
    expect(parseActiveTaskPath("/threads/environment/thread/files")).toBeNull();
    expect(parseActiveTaskPath("/tasks/%E0%A4%A/task")).toBeNull();
  });
  it("replaces a tablet task when selecting a thread and keeps compact back navigation", () => {
    expect(
      resolveThreadSelectionNavigationAction({
        usesSplitView: true,
        pathname: "/tasks/environment/task",
      }),
    ).toBe("replace");
    expect(
      resolveTaskSelectionNavigationAction({
        usesSplitView: true,
        pathname: "/threads/environment/thread",
      }),
    ).toBe("replace");
    expect(
      resolveTaskSelectionNavigationAction({
        usesSplitView: true,
        pathname: "/tasks/environment/task",
      }),
    ).toBe("set-params");
    expect(
      resolveTaskSelectionNavigationAction({
        usesSplitView: false,
        pathname: "/tasks/environment/task",
      }),
    ).toBe("push");
  });
});

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

  it("pushes from Home so the back stack survives collapsing to compact", () => {
    expect(
      resolveThreadSelectionNavigationAction({
        usesSplitView: true,
        pathname: "/",
      }),
    ).toBe("push");
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
