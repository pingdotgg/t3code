import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearShowcaseRenderSignal,
  getShowcaseRenderSignal,
  isShowcaseNativeContentReady,
  reportShowcaseSceneRendered,
  subscribeToShowcaseRenderSignal,
} from "./showcaseRenderSignal";

afterEach(clearShowcaseRenderSignal);

describe("showcase native content readiness", () => {
  it("does not gate scenes whose content is rendered by React Native", () => {
    expect(
      isShowcaseNativeContentReady({ scene: "environments", themeId: "grove", renderSignal: null }),
    ).toBe(true);
  });

  it("waits for the native review surface to draw the active theme", () => {
    expect(
      isShowcaseNativeContentReady({ scene: "review", themeId: "grove", renderSignal: null }),
    ).toBe(false);
    expect(
      isShowcaseNativeContentReady({
        scene: "review",
        themeId: "grove",
        renderSignal: { scene: "review", themeId: "ocean" },
      }),
    ).toBe(false);
    expect(
      isShowcaseNativeContentReady({
        scene: "review",
        themeId: "grove",
        renderSignal: { scene: "review", themeId: "grove" },
      }),
    ).toBe(true);
  });

  it("clears a draw when the runner requests another scene", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToShowcaseRenderSignal(listener);

    reportShowcaseSceneRendered({ scene: "review", themeId: "iris" });
    expect(getShowcaseRenderSignal()).toEqual({ scene: "review", themeId: "iris" });
    clearShowcaseRenderSignal();
    expect(getShowcaseRenderSignal()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });
});
