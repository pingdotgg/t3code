import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ createPlayer: vi.fn() }));
vi.mock("expo-video", () => ({ createVideoPlayer: mocks.createPlayer }));

let thumbnails: typeof import("./videoThumbnails");
const frame = { width: 480, height: 270 };
const player = () => ({
  replaceAsync: vi.fn(async (): Promise<void> => {}),
  generateThumbnailsAsync: vi.fn(async () => [frame]),
  release: vi.fn(),
});
const source = () => ({ uri: "file:///clip.mp4", dispose: vi.fn() });

beforeEach(async () => {
  vi.resetModules();
  mocks.createPlayer.mockReset().mockImplementation(player);
  thumbnails = await import("./videoThumbnails");
});

afterEach(() => vi.useRealTimers());

describe("video thumbnails", () => {
  it("reuses a frame for duplicate requests and refreshed signed URLs", async () => {
    const file = source();
    const resolveSource = vi.fn(async () => file);
    const signal = new AbortController().signal;
    const results = await Promise.all([
      thumbnails.loadVideoThumbnail("env:clip", resolveSource, signal),
      thumbnails.loadVideoThumbnail("env:clip", resolveSource, signal),
    ]);
    expect(results).toEqual([frame, frame]);
    expect(resolveSource).toHaveBeenCalledTimes(1);
    expect(mocks.createPlayer).toHaveBeenCalledTimes(1);
    expect(file.dispose).toHaveBeenCalledTimes(1);
    const refreshed = vi.fn(async () => ({ ...source(), uri: "https://host/new-token/clip.mp4" }));
    expect(await thumbnails.loadVideoThumbnail("env:clip", refreshed, signal)).toBe(frame);
    expect(refreshed).not.toHaveBeenCalled();
  });

  it("serializes decoding and skips queued requests that scroll out of view", async () => {
    const started = Promise.withResolvers<void>();
    const generated = Promise.withResolvers<(typeof frame)[]>();
    const first = player();
    first.generateThumbnailsAsync.mockImplementation(() => {
      started.resolve();
      return generated.promise;
    });
    mocks.createPlayer.mockReturnValueOnce(first);
    const firstRequest = thumbnails.loadVideoThumbnail(
      "first",
      async () => source(),
      new AbortController().signal,
    );
    await started.promise;
    const removed = new AbortController();
    const skipped = vi.fn(async () => source());
    const queued = thumbnails.loadVideoThumbnail("removed", skipped, removed.signal);
    const next = vi.fn(async () => source());
    const nextRequest = thumbnails.loadVideoThumbnail("next", next, new AbortController().signal);
    expect(next).not.toHaveBeenCalled();
    removed.abort();
    generated.resolve([frame]);
    expect(await firstRequest).toBe(frame);
    expect(await queued).toBeNull();
    expect(await nextRequest).toBe(frame);
    expect(skipped).not.toHaveBeenCalled();
    expect(first.release).toHaveBeenCalledTimes(1);
  });

  it("releases an active canceled player and ignores late source loading", async () => {
    const started = Promise.withResolvers<void>();
    const replaced = Promise.withResolvers<void>();
    const first = player();
    first.replaceAsync.mockImplementation(() => {
      started.resolve();
      return replaced.promise;
    });
    mocks.createPlayer.mockReturnValueOnce(first);
    const file = source();
    const controller = new AbortController();
    const request = thumbnails.loadVideoThumbnail("canceled", async () => file, controller.signal);
    await started.promise;
    controller.abort();
    expect(await request).toBeNull();
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(file.dispose).toHaveBeenCalledTimes(1);
    replaced.resolve();
    expect(
      await thumbnails.loadVideoThumbnail(
        "next",
        async () => source(),
        new AbortController().signal,
      ),
    ).toBe(frame);
    expect(first.generateThumbnailsAsync).not.toHaveBeenCalled();
    expect(thumbnails.cachedVideoThumbnail("canceled")).toBeNull();
  });

  it("releases failed extractions and permits a later retry", async () => {
    const broken = player();
    broken.generateThumbnailsAsync.mockRejectedValue(new Error("Invalid video"));
    mocks.createPlayer.mockReturnValueOnce(broken);
    const file = source();
    expect(
      await thumbnails.loadVideoThumbnail("retry", async () => file, new AbortController().signal),
    ).toBeNull();
    expect(broken.release).toHaveBeenCalledTimes(1);
    expect(file.dispose).toHaveBeenCalledTimes(1);
    expect(
      await thumbnails.loadVideoThumbnail(
        "retry",
        async () => source(),
        new AbortController().signal,
      ),
    ).toBe(frame);
  });

  it("does not let an unreachable source block the queue indefinitely", async () => {
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const first = player();
    first.replaceAsync.mockImplementation(() => {
      started.resolve();
      return new Promise(() => {});
    });
    mocks.createPlayer.mockReturnValueOnce(first);
    const file = source();
    const request = thumbnails.loadVideoThumbnail(
      "unreachable",
      async () => file,
      new AbortController().signal,
    );
    await started.promise;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await request).toBeNull();
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(file.dispose).toHaveBeenCalledTimes(1);
    expect(
      await thumbnails.loadVideoThumbnail(
        "reachable",
        async () => source(),
        new AbortController().signal,
      ),
    ).toBe(frame);
  });

  it("bounds the retained native images without invalidating frames still displayed", async () => {
    for (let i = 0; i < 33; i++) {
      await thumbnails.loadVideoThumbnail(
        `clip:${i}`,
        async () => source(),
        new AbortController().signal,
      );
    }
    expect(thumbnails.cachedVideoThumbnail("clip:0")).toBeNull();
    expect(thumbnails.cachedVideoThumbnail("clip:32")).toBe(frame);
    expect(mocks.createPlayer).toHaveBeenCalledTimes(33);
    expect(
      await thumbnails.loadVideoThumbnail(
        "clip:0",
        async () => source(),
        new AbortController().signal,
      ),
    ).toBe(frame);
    expect(mocks.createPlayer).toHaveBeenCalledTimes(34);
  });
});
