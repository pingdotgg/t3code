import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { attachRecordingCursorCompositor } from "./browserRecordingCursor";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup() {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let frame: (() => void) | undefined;
  const video = {
    srcObject: null as MediaStream | null,
    muted: false,
    videoWidth: 800,
    videoHeight: 600,
    requestVideoFrameCallback: vi.fn((callback: () => void) => {
      frame = callback;
      return 1;
    }),
    cancelVideoFrameCallback: vi.fn(),
    play: vi.fn(async () => {
      frame?.();
    }),
  };
  const output = { getTracks: () => [] };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn((): object | null => ({ fillRect: vi.fn(), drawImage: vi.fn() })),
    captureStream: vi.fn(() => output),
  };
  const getSettings = vi.fn(() => ({ width: 800, height: 600 }));
  const stream = { getVideoTracks: () => [{ getSettings }] } as unknown as MediaStream;
  vi.stubGlobal("document", { createElement: (tag: string) => (tag === "video" ? video : canvas) });
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  const start = () =>
    attachRecordingCursorCompositor({
      tabId: "startup-test",
      serverTabId: "startup-test",
      stream,
      threadRef: null,
      frameRate: 30,
    });
  return { warn, video, canvas, getSettings, start };
}

describe("cursor compositor fallback diagnostics", () => {
  it("reports missing track dimensions", async () => {
    const { start, warn, getSettings } = setup();
    getSettings.mockReturnValue({ width: 0, height: 0 });
    expect(await start()).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("missing or invalid capture track dimensions"),
    );
  });

  it("reports unsupported frame callbacks", async () => {
    const { start, warn, video } = setup();
    Object.defineProperty(video, "requestVideoFrameCallback", { value: undefined });
    expect(await start()).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("requestVideoFrameCallback is unsupported"),
    );
  });

  it("reports an unavailable canvas context and detaches the stream", async () => {
    const { start, warn, video, canvas } = setup();
    canvas.getContext.mockReturnValue(null);
    expect(await start()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("2D canvas context is unavailable"));
    expect(video.srcObject).toBeNull();
  });

  it("reports the stage and cause when reading settings throws", async () => {
    const { start, warn, getSettings } = setup();
    getSettings.mockImplementation(() => {
      throw new Error("track ended");
    });
    expect(await start()).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("read capture track settings threw: Error: track ended"),
    );
  });

  it("reports play rejection and detaches the stream", async () => {
    const { start, warn, video } = setup();
    video.play.mockRejectedValue(new Error("not allowed"));
    expect(await start()).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("video play() rejected: Error: not allowed"),
    );
    expect(video.srcObject).toBeNull();
    expect(video.cancelVideoFrameCallback).toHaveBeenCalled();
  });

  it("reports a first-frame timeout and cancels the pending callback", async () => {
    const { start, warn, video } = setup();
    video.play.mockImplementation(() => new Promise(() => {}));
    const result = start();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await result).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("first captured frame timed out"));
    expect(video.srcObject).toBeNull();
    expect(video.cancelVideoFrameCallback).toHaveBeenCalled();
  });

  it("reports captureStream failure and cleans up the video", async () => {
    const { start, warn, video, canvas } = setup();
    canvas.captureStream.mockImplementation(() => {
      throw new Error("unsupported");
    });
    expect(await start()).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("captureStream() threw: Error: unsupported"),
    );
    expect(video.srcObject).toBeNull();
    expect(video.cancelVideoFrameCallback).toHaveBeenCalled();
  });

  it("does not warn when startup succeeds", async () => {
    const { start, warn, video } = setup();
    const compositor = await start();
    expect(compositor).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
    compositor?.dispose();
    expect(video.srcObject).toBeNull();
  });
});
