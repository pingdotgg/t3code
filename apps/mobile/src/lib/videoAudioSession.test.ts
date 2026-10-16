import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  platform: { OS: "ios" as "ios" | "android" },
  release: vi.fn(async (): Promise<void> => {}),
}));
vi.mock("react-native", () => ({ Platform: mocks.platform }));
vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({ releaseVideoAudioSession: mocks.release }),
}));

let session: typeof import("./videoAudioSession");

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.platform.OS = "ios";
  mocks.release.mockClear().mockResolvedValue(undefined);
  session = await import("./videoAudioSession");
});

afterEach(() => vi.useRealTimers());

describe("video audio session", () => {
  it("releases once, after the last playing player stops, unless playback restarts first", () => {
    session.mediaPlaybackStarted();
    session.mediaPlaybackStarted();
    session.mediaPlaybackStopped();
    vi.advanceTimersByTime(1_000);
    expect(mocks.release).not.toHaveBeenCalled();

    // A player starting inside the deferral window keeps the session.
    session.mediaPlaybackStopped();
    session.mediaPlaybackStarted();
    vi.advanceTimersByTime(1_000);
    expect(mocks.release).not.toHaveBeenCalled();

    session.mediaPlaybackStopped();
    vi.advanceTimersByTime(1_000);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("stays fullscreen until every overlapping presentation closes", () => {
    const listener = vi.fn();
    session.subscribeFullscreenVideo(listener);
    session.fullscreenVideoOpened();
    session.fullscreenVideoOpened();
    session.fullscreenVideoClosed();
    expect(session.isFullscreenVideoOpen()).toBe(true);
    session.fullscreenVideoClosed();
    expect(session.isFullscreenVideoOpen()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
