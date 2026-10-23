import { describe, expect, it } from "vite-plus/test";

import {
  commitBrowserViewportChange,
  subscribeBrowserViewportChange,
} from "./browserViewportActions";

describe("browserViewportActions", () => {
  it("commits viewport changes in order for each tab", async () => {
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const calls: Array<number> = [];
    const unsubscribe = subscribeBrowserViewportChange("tab-serial", async (setting) => {
      if (setting._tag === "fill") return;
      calls.push(setting.width);
      if (setting.width === 800) {
        markFirstStarted?.();
        await firstPending;
      }
    });

    const first = commitBrowserViewportChange("tab-serial", {
      _tag: "freeform",
      width: 800,
      height: 600,
    });
    const second = commitBrowserViewportChange("tab-serial", {
      _tag: "freeform",
      width: 900,
      height: 700,
    });
    await firstStarted;
    expect(calls).toEqual([800]);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(calls).toEqual([800, 900]);
    unsubscribe();
  });
});
