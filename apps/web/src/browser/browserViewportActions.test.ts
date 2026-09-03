import type { PreviewViewportSetting } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  BROWSER_VIEWPORT_COMMIT_TIMEOUT_MS,
  commitBrowserViewportChange,
  runBrowserViewportMutation,
  subscribeBrowserViewportChange,
} from "./browserViewportActions";

describe("browserViewportActions", () => {
  it("routes drag commits to the visible tab handler and cleans up exactly that handler", async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const unsubscribeFirst = subscribeBrowserViewportChange("tab-1", first);
    const unsubscribeSecond = subscribeBrowserViewportChange("tab-1", second);

    unsubscribeFirst();
    await commitBrowserViewportChange("tab-1", {
      _tag: "freeform",
      width: 900,
      height: 700,
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ _tag: "freeform", width: 900, height: 700 });

    unsubscribeSecond();
    await expect(
      commitBrowserViewportChange("tab-1", {
        _tag: "freeform",
        width: 800,
        height: 600,
      }),
    ).rejects.toThrow("No visible browser viewport handler");
  });

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

  it("serializes background mutations with visible viewport commits", async () => {
    let releaseBackground: (() => void) | undefined;
    const backgroundPending = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });
    const calls: string[] = [];
    const background = runBrowserViewportMutation("tab-shared", async () => {
      calls.push("background");
      await backgroundPending;
    });
    const unsubscribe = subscribeBrowserViewportChange("tab-shared", async () => {
      calls.push("visible");
    });
    const visible = commitBrowserViewportChange("tab-shared", {
      _tag: "freeform",
      width: 900,
      height: 700,
    });

    await vi.waitFor(() => expect(calls).toEqual(["background"]));
    releaseBackground?.();
    await Promise.all([background, visible]);

    expect(calls).toEqual(["background", "visible"]);
    unsubscribe();
  });

  it("releases a newer viewport commit when an earlier handler times out", async () => {
    vi.useFakeTimers();
    try {
      let releaseFirst: (() => void) | undefined;
      const delayed = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const handler = vi.fn(async (_setting: PreviewViewportSetting): Promise<void> => undefined);
      handler.mockImplementationOnce(() => delayed).mockResolvedValueOnce(undefined);
      const unsubscribe = subscribeBrowserViewportChange("tab-timeout", handler);
      const first = commitBrowserViewportChange("tab-timeout", {
        _tag: "freeform",
        width: 800,
        height: 600,
      });
      const firstResult = expect(first).rejects.toThrow(
        "Timed out committing the browser viewport for tab tab-timeout",
      );

      await vi.advanceTimersByTimeAsync(BROWSER_VIEWPORT_COMMIT_TIMEOUT_MS - 1);
      expect(handler).toHaveBeenCalledTimes(1);

      const second = commitBrowserViewportChange("tab-timeout", {
        _tag: "freeform",
        width: 900,
        height: 700,
      });
      await vi.advanceTimersByTimeAsync(1);
      await firstResult;
      await second;

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[1]?.[0]).toMatchObject({ width: 900, height: 700 });
      releaseFirst?.();
      await Promise.resolve();

      await commitBrowserViewportChange("tab-timeout", {
        _tag: "freeform",
        width: 1_000,
        height: 800,
      });
      expect(handler).toHaveBeenCalledTimes(3);
      expect(handler.mock.calls[2]?.[0]).toMatchObject({ width: 1_000, height: 800 });
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires a queued commit before its handler can write", async () => {
    vi.useFakeTimers();
    try {
      let releaseBackground: (() => void) | undefined;
      const backgroundPending = new Promise<void>((resolve) => {
        releaseBackground = resolve;
      });
      const background = runBrowserViewportMutation("tab-queued-timeout", () => backgroundPending);
      const handler = vi.fn(async () => undefined);
      const unsubscribe = subscribeBrowserViewportChange("tab-queued-timeout", handler);
      const commit = commitBrowserViewportChange("tab-queued-timeout", {
        _tag: "freeform",
        width: 900,
        height: 700,
      });
      const result = expect(commit).rejects.toThrow(
        "Timed out committing the browser viewport for tab tab-queued-timeout",
      );

      await vi.advanceTimersByTimeAsync(BROWSER_VIEWPORT_COMMIT_TIMEOUT_MS);
      await result;
      releaseBackground?.();
      await background;
      await vi.runAllTimersAsync();

      expect(handler).not.toHaveBeenCalled();
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the queue when an in-flight background mutation reaches its deadline", async () => {
    vi.useFakeTimers();
    try {
      let releaseFirst: (() => void) | undefined;
      const firstPending = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const calls: string[] = [];
      const timeoutError = () => new Error("background viewport mutation expired");
      const first = runBrowserViewportMutation(
        "tab-background-deadline",
        async () => {
          calls.push("first");
          await firstPending;
        },
        {
          deadlineAt: Date.now() + 1_000,
          timeoutError,
        },
      );
      const firstResult = expect(first).rejects.toThrow("background viewport mutation expired");
      const second = runBrowserViewportMutation("tab-background-deadline", async () => {
        calls.push("second");
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await firstResult;
      await second;
      expect(calls).toEqual(["first", "second"]);

      releaseFirst?.();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });
});
