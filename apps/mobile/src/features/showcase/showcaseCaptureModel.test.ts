import { describe, expect, it } from "vite-plus/test";

import {
  isShowcaseThemeApplied,
  showcaseReadinessKey,
  showcaseSceneOnScreen,
  shouldNavigateToShowcaseScene,
  type ShowcaseReadinessInput,
} from "./showcaseCaptureModel";

const ready: ShowcaseReadinessInput = {
  scene: "thread",
  requestedScene: "thread",
  hasFixture: true,
  orientationSettled: true,
  themeApplied: true,
  agentActivityStaged: false,
  themeId: "t3-code",
  renderSignal: null,
  renderReports: 0,
};

describe("showcaseSceneOnScreen", () => {
  it("treats the threads list as the agent activity scene only when that scene is requested", () => {
    expect(showcaseSceneOnScreen("agent-activity", "/")).toBe("agent-activity");
    expect(showcaseSceneOnScreen("threads", "/")).toBe("threads");
    expect(showcaseSceneOnScreen("agent-activity", "/threads/env/thread")).toBe("thread");
    expect(showcaseSceneOnScreen(null, "/threads/env/thread/review?x=1")).toBe("review");
  });
});

describe("isShowcaseThemeApplied", () => {
  it("waits for the launch request when no theme is requested", () => {
    const themeIds = { light: "t3-code", dark: "t3-code" } as const;
    expect(
      isShowcaseThemeApplied({ launchRequestRead: false, requestedTheme: null, themeIds }),
    ).toBe(false);
    expect(
      isShowcaseThemeApplied({ launchRequestRead: true, requestedTheme: null, themeIds }),
    ).toBe(true);
  });

  it("requires both appearances to use the requested theme", () => {
    expect(
      isShowcaseThemeApplied({
        launchRequestRead: true,
        requestedTheme: "t3-code",
        themeIds: { light: "t3-code", dark: "material-you" },
      }),
    ).toBe(false);
  });
});

describe("showcaseReadinessKey", () => {
  it("is null until every precondition holds", () => {
    expect(showcaseReadinessKey(ready)).not.toBeNull();
    expect(showcaseReadinessKey({ ...ready, requestedScene: "terminal" })).toBeNull();
    expect(showcaseReadinessKey({ ...ready, hasFixture: false })).toBeNull();
    expect(showcaseReadinessKey({ ...ready, orientationSettled: false })).toBeNull();
    expect(showcaseReadinessKey({ ...ready, themeApplied: false })).toBeNull();
  });

  it("waits for agent activity to be staged", () => {
    const agentActivity = {
      ...ready,
      scene: "agent-activity",
      requestedScene: "agent-activity",
    } as const;
    expect(showcaseReadinessKey(agentActivity)).toBeNull();
    expect(showcaseReadinessKey({ ...agentActivity, agentActivityStaged: true })).not.toBeNull();
  });

  it("waits for review to report a draw in the current theme, and changes key when it redraws", () => {
    const review = { ...ready, scene: "review", requestedScene: "review" } as const;
    expect(showcaseReadinessKey(review)).toBeNull();
    expect(
      showcaseReadinessKey({
        ...review,
        renderSignal: { scene: "review", themeId: "material-you" },
      }),
    ).toBeNull();
    const drawn = { ...review, renderSignal: { scene: "review", themeId: "t3-code" } } as const;
    const firstDraw = showcaseReadinessKey({ ...drawn, renderReports: 1 });
    expect(firstDraw).not.toBeNull();
    expect(showcaseReadinessKey({ ...drawn, renderReports: 2 })).not.toBe(firstDraw);
  });
});

describe("shouldNavigateToShowcaseScene", () => {
  it("dispatches again when the thread shell changes while the scene is still not on screen", () => {
    const shell = { id: "remote-command-center" };
    const first = { requestedScene: "review", scene: "threads", thread: shell } as const;
    expect(shouldNavigateToShowcaseScene(null, first)).toBe(true);
    expect(shouldNavigateToShowcaseScene(first, { ...first })).toBe(false);
    expect(shouldNavigateToShowcaseScene(first, { ...first, thread: { ...shell } })).toBe(true);
    expect(shouldNavigateToShowcaseScene(first, { ...first, scene: "thread" })).toBe(true);
    expect(shouldNavigateToShowcaseScene(first, { ...first, scene: "review" })).toBe(false);
  });
});
