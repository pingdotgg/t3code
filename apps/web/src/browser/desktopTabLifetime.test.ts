import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { closeTab, createTab, stopBrowserRecording } = vi.hoisted(() => ({
  closeTab: vi.fn<(tabId: string) => Promise<void>>(async () => undefined),
  createTab: vi.fn<() => Promise<void>>(),
  stopBrowserRecording: vi.fn(async () => null),
}));

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { closeTab, createTab },
}));

vi.mock("./browserRecording", () => ({
  stopBrowserRecording,
}));

import { acquireDesktopTab } from "./desktopTabLifetime";

describe("desktopTabLifetime", () => {
  beforeEach(() => {
    closeTab.mockClear();
    createTab.mockClear();
    stopBrowserRecording.mockClear();
    vi.stubGlobal("window", globalThis);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shares tab creation readiness across concurrent leases", async () => {
    let resolveCreation: (() => void) | undefined;
    createTab.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCreation = resolve;
      }),
    );

    const first = acquireDesktopTab("tab_readiness");
    const second = acquireDesktopTab("tab_readiness");

    expect(createTab).toHaveBeenCalledOnce();
    expect(first.ready).toBe(second.ready);

    let ready = false;
    void first.ready.then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);

    resolveCreation?.();
    await first.ready;
    expect(ready).toBe(true);
  });

  it("stops recording before closing the final desktop tab lease", async () => {
    vi.useFakeTimers();
    let resolveStop: (() => void) | undefined;
    stopBrowserRecording.mockReturnValueOnce(
      new Promise<null>((resolve) => {
        resolveStop = () => resolve(null);
      }),
    );
    createTab.mockResolvedValueOnce(undefined);

    const lease = acquireDesktopTab("tab_recording_cleanup");
    await lease.ready;
    lease.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(stopBrowserRecording).toHaveBeenCalledWith("tab_recording_cleanup");
    expect(closeTab).not.toHaveBeenCalled();

    resolveStop?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(closeTab).toHaveBeenCalledWith("tab_recording_cleanup");
  });

  it("waits for an in-flight close before recreating a reacquired tab", async () => {
    vi.useFakeTimers();
    let resolveClose: (() => void) | undefined;
    createTab.mockResolvedValue(undefined);
    closeTab.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveClose = resolve;
      }),
    );

    const initial = acquireDesktopTab("tab_close_reacquire");
    await initial.ready;
    initial.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(closeTab).toHaveBeenCalledWith("tab_close_reacquire");

    const reacquired = acquireDesktopTab("tab_close_reacquire");
    expect(createTab).toHaveBeenCalledTimes(1);

    resolveClose?.();
    await reacquired.ready;
    expect(createTab).toHaveBeenCalledTimes(2);
  });
});
