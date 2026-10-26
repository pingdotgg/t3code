import { describe, expect, it } from "vite-plus/test";

import { findLinkedRoute, restoreDraftLinkState, shouldHandleAppLink } from "./appLinking";

describe("shouldHandleAppLink", () => {
  it.each(["t3code://", "t3code:///", "t3code-dev://", "t3code-preview://"])(
    "ignores scheme-only URL %s",
    (url) => {
      expect(shouldHandleAppLink(url, true)).toBe(false);
    },
  );

  it.each([
    "t3code://threads/env-1/thread-1",
    "t3code://pair?pairingUrl=x",
    "t3code-dev://settings/usage?tab=limits",
  ])("handles path-bearing URL %s", (url) => {
    expect(shouldHandleAppLink(url, true)).toBe(true);
  });

  it.each(["t3code://expo-development-client/?url=x", "t3code://expo-sharing/anything"])(
    "ignores lifecycle URL %s",
    (url) => {
      expect(shouldHandleAppLink(url, true)).toBe(false);
    },
  );
});

describe("cloud-only deep links", () => {
  it.each([
    "t3code://connect-onboarding",
    "t3code-dev://connect-onboarding/?source=x",
    "t3code://settings/waitlist",
    "t3code://settings/auth",
    "exp://192.168.1.2:8081/--/settings/auth",
  ])("ignores %s without cloud config", (url) => {
    expect(shouldHandleAppLink(url, false)).toBe(false);
    expect(shouldHandleAppLink(url, true)).toBe(true);
  });

  it.each([
    "t3code://settings",
    "t3code://settings/authors",
    "t3code://pair?next=settings/auth",
    "t3code://threads/env/thread/files/scripts/connect-onboarding",
    "t3code://new/draft/files/settings/auth",
    "exp://192.168.1.2:8081/--/threads/env/thread/files/settings/waitlist",
  ])("still handles %s without cloud config", (url) => {
    expect(shouldHandleAppLink(url, false)).toBe(true);
  });
});

describe("draft deep links", () => {
  it("opens the old draft URL on the thread screen with its draft identity", () => {
    const draft = { projectId: "project-1", environmentId: "env-1", draftId: "draft-1" };
    expect(
      restoreDraftLinkState(
        { routes: [{ name: "Home" }, { name: "Thread", params: draft }] },
        "/new/draft?draftId=draft-1",
      ),
    ).toEqual({
      index: 1,
      routes: [{ name: "Home" }, { name: "Thread", params: { draft } }],
    });
  });

  it.each([
    ["environment", "NewTaskEnvironment"],
    ["branch", "NewTaskBranch"],
    ["files", "NewTaskFiles"],
    ["files/src/index.ts", "NewTaskFile"],
    ["attachments/attachment-1", "NewTaskAttachment"],
    ["settings", "NewTaskThreadSettings"],
  ])("restores a draft beneath its %s screen", (path, name) => {
    const params = { environmentId: "env-1", projectId: "project-1" };
    const target = { name, params };
    expect(
      restoreDraftLinkState({ routes: [{ name: "Home" }, target] }, `/new/draft/${path}`),
    ).toEqual({
      index: 2,
      routes: [{ name: "Home" }, { name: "Thread", params: { draft: params } }, target],
    });
  });

  it("leaves live-thread and project-selection links unchanged", () => {
    const state = { routes: [{ name: "Thread", params: { threadId: "thread-1" } }] };
    expect(restoreDraftLinkState(state, "/threads/env-1/thread-1")).toBe(state);
    expect(restoreDraftLinkState(state, "/new")).toBe(state);
    expect(restoreDraftLinkState(undefined, "/new/draft")).toBeUndefined();
  });
});

describe("nested link routes", () => {
  const settingsLink = {
    routes: [
      { name: "Home" },
      {
        name: "SettingsSheet",
        state: {
          routes: [
            { name: "Settings" },
            { name: "SettingsEnvironmentNew", params: { pairingUrl: "x", autoConnect: "1" } },
          ],
        },
      },
    ],
  };

  it("finds a route the link opens inside a nested navigator", () => {
    expect(findLinkedRoute(settingsLink, ["SettingsEnvironmentNew"])?.params).toEqual({
      pairingUrl: "x",
      autoConnect: "1",
    });
    expect(findLinkedRoute(settingsLink, ["ConnectionsNew"])).toBeUndefined();
  });
});
