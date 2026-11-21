import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal, type Screen } from "../../../test/render";
import { MediaVideoPlayer } from "./MediaVideoPlayer";

// The observer never reports the video as visible, so it keeps preload="none" and never
// requests these fake URLs; the test fires the media events itself.
class HiddenIntersectionObserver {
  observe() {}
  disconnect() {}
}

class VisibleIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [{ target, isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

function expectVideoSrc(screen: Screen, src: string) {
  return expect.element(screen.getByLabelText("clip")).toHaveAttribute("src", src);
}

async function loadMetadata(screen: Screen) {
  await act(() => {
    screen.getByLabelText("clip").element().dispatchEvent(new Event("loadedmetadata"));
  });
}

describe("MediaVideoPlayer", () => {
  it("keeps a loaded paused video when only its URL is re-signed", async () => {
    using _observer = stubGlobal("IntersectionObserver", HiddenIntersectionObserver);
    await using screen = await render(
      <MediaVideoPlayer src="/asset/first/clip.mp4" label="clip" revision="file-1" />,
    );
    await loadMetadata(screen);

    await screen.rerender(
      <MediaVideoPlayer src="/asset/renewed/clip.mp4" label="clip" revision="file-1" />,
    );
    await expectVideoSrc(screen, "/asset/first/clip.mp4");

    await screen.rerender(
      <MediaVideoPlayer src="/asset/changed/clip.mp4" label="clip" revision="file-2" />,
    );
    await expectVideoSrc(screen, "/asset/changed/clip.mp4");

    // A second re-sign while the changed file is still loading must not restart that load.
    await screen.rerender(
      <MediaVideoPlayer src="/asset/changed-renewed/clip.mp4" label="clip" revision="file-2" />,
    );
    await expectVideoSrc(screen, "/asset/changed/clip.mp4");
  });

  it("keeps a loaded paused video while its URL is briefly unavailable", async () => {
    using _observer = stubGlobal("IntersectionObserver", HiddenIntersectionObserver);
    await using screen = await render(
      <MediaVideoPlayer src="/asset/first/clip.mp4" label="clip" revision="file-1" />,
    );
    await loadMetadata(screen);

    await screen.rerender(<MediaVideoPlayer src={null} label="clip" revision="mutation-2" />);
    await expectVideoSrc(screen, "/asset/first/clip.mp4");
  });

  it("starts loading metadata once the player scrolls near the viewport", async () => {
    using _observer = stubGlobal("IntersectionObserver", VisibleIntersectionObserver);
    await using screen = await render(<MediaVideoPlayer src="/asset/clip.mp4" label="clip" />);

    await expect.element(screen.getByLabelText("clip")).toHaveAttribute("preload", "metadata");
  });

  it("keeps a playing video playing when the player rerenders", async () => {
    using _observer = stubGlobal("IntersectionObserver", HiddenIntersectionObserver);
    await using screen = await render(
      <MediaVideoPlayer src="/asset/clip.mp4" label="clip" className="w-40" />,
    );
    const video = screen.getByLabelText("clip").element() as HTMLVideoElement;
    using pause = vi.spyOn(video, "pause");
    await act(() => {
      video.dispatchEvent(new Event("play"));
    });

    await screen.rerender(<MediaVideoPlayer src="/asset/clip.mp4" label="clip" className="w-48" />);

    expect(pause).not.toHaveBeenCalled();
  });

  it("pauses a playing video when it scrolls out of the viewport", async () => {
    const subscriptions: Array<{
      readonly callback: IntersectionObserverCallback;
      target: Element;
    }> = [];
    class OffscreenObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        subscriptions.push({ callback: this.callback, target });
      }
      unobserve() {}
      disconnect() {}
    }
    using _observer = stubGlobal("IntersectionObserver", OffscreenObserver);
    await using screen = await render(<MediaVideoPlayer src="/asset/clip.mp4" label="clip" />);
    const video = screen.getByLabelText("clip").element() as HTMLVideoElement;
    using pause = vi.spyOn(video, "pause");
    await act(() => {
      video.dispatchEvent(new Event("play"));
    });

    await act(() => {
      for (const { callback, target } of subscriptions) {
        callback(
          [{ target, isIntersecting: false } as IntersectionObserverEntry],
          undefined as unknown as IntersectionObserver,
        );
      }
    });

    expect(pause).toHaveBeenCalled();
  });

  it("pauses a playing video that leaves fullscreen while it is out of view", async () => {
    const observers: Array<{
      readonly callback: IntersectionObserverCallback;
      target: Element | null;
    }> = [];
    class RecordingObserver {
      readonly callback: IntersectionObserverCallback;
      target: Element | null = null;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        observers.push(this);
      }
      observe(target: Element) {
        this.target = target;
      }
      unobserve() {}
      disconnect() {}
    }
    using _observer = stubGlobal("IntersectionObserver", RecordingObserver);
    using _hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    await using screen = await render(<MediaVideoPlayer src="/asset/clip.mp4" label="clip" />);
    const video = screen.getByLabelText("clip").element() as HTMLVideoElement;
    using pause = vi.spyOn(video, "pause");
    Object.defineProperty(video, "webkitDisplayingFullscreen", { value: true, configurable: true });
    await act(() => {
      video.dispatchEvent(new Event("play"));
    });

    // The fullscreen player keeps playing even though the inline box left the viewport.
    await act(() => {
      for (const observer of observers) {
        if (!observer.target) continue;
        observer.callback(
          [{ target: observer.target, isIntersecting: false } as IntersectionObserverEntry],
          undefined as unknown as IntersectionObserver,
        );
      }
    });
    expect(pause).not.toHaveBeenCalled();

    Object.defineProperty(video, "webkitDisplayingFullscreen", {
      value: false,
      configurable: true,
    });
    const checks = observers.length;
    await act(() => {
      video.dispatchEvent(new Event("webkitendfullscreen"));
    });

    // The exit starts a fresh check, since the shared observer cannot re-report.
    expect(observers.length).toBeGreaterThan(checks);
    const fresh = observers.at(-1);
    await act(() => {
      fresh?.callback(
        [{ target: video, isIntersecting: false } as unknown as IntersectionObserverEntry],
        undefined as unknown as IntersectionObserver,
      );
    });
    expect(pause).toHaveBeenCalled();
  });

  it("keeps a playing video that leaves fullscreen while it is still in view", async () => {
    const observers: Array<{
      readonly callback: IntersectionObserverCallback;
      target: Element | null;
    }> = [];
    class RecordingObserver {
      readonly callback: IntersectionObserverCallback;
      target: Element | null = null;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        observers.push(this);
      }
      observe(target: Element) {
        this.target = target;
      }
      unobserve() {}
      disconnect() {}
    }
    using _observer = stubGlobal("IntersectionObserver", RecordingObserver);
    using _hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    await using screen = await render(<MediaVideoPlayer src="/asset/clip.mp4" label="clip" />);
    const video = screen.getByLabelText("clip").element() as HTMLVideoElement;
    using pause = vi.spyOn(video, "pause");
    Object.defineProperty(video, "webkitDisplayingFullscreen", { value: true, configurable: true });
    await act(() => {
      video.dispatchEvent(new Event("play"));
    });

    await act(() => {
      for (const observer of observers) {
        if (!observer.target) continue;
        observer.callback(
          [{ target: observer.target, isIntersecting: false } as IntersectionObserverEntry],
          undefined as unknown as IntersectionObserver,
        );
      }
    });
    Object.defineProperty(video, "webkitDisplayingFullscreen", {
      value: false,
      configurable: true,
    });
    const checks = observers.length;
    await act(() => {
      video.dispatchEvent(new Event("webkitendfullscreen"));
    });

    // The exit starts a fresh check, since the shared observer cannot re-report.
    expect(observers.length).toBeGreaterThan(checks);
    const fresh = observers.at(-1);
    await act(() => {
      fresh?.callback(
        [{ target: video, isIntersecting: true } as unknown as IntersectionObserverEntry],
        undefined as unknown as IntersectionObserver,
      );
    });

    expect(pause).not.toHaveBeenCalled();
  });

  it("keeps a playing video that returns to fullscreen before the check reports", async () => {
    const observers: Array<{
      readonly callback: IntersectionObserverCallback;
      target: Element | null;
    }> = [];
    class RecordingObserver {
      readonly callback: IntersectionObserverCallback;
      target: Element | null = null;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        observers.push(this);
      }
      observe(target: Element) {
        this.target = target;
      }
      unobserve() {}
      disconnect() {}
    }
    using _observer = stubGlobal("IntersectionObserver", RecordingObserver);
    using _hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    await using screen = await render(<MediaVideoPlayer src="/asset/clip.mp4" label="clip" />);
    const video = screen.getByLabelText("clip").element() as HTMLVideoElement;
    using pause = vi.spyOn(video, "pause");
    Object.defineProperty(video, "webkitDisplayingFullscreen", { value: true, configurable: true });
    await act(() => {
      video.dispatchEvent(new Event("play"));
    });

    Object.defineProperty(video, "webkitDisplayingFullscreen", {
      value: false,
      configurable: true,
    });
    const checks = observers.length;
    await act(() => {
      video.dispatchEvent(new Event("webkitendfullscreen"));
    });
    expect(observers.length).toBeGreaterThan(checks);
    const fresh = observers.at(-1);

    // The report is queued, so fullscreen can be up again before it arrives.
    Object.defineProperty(video, "webkitDisplayingFullscreen", { value: true, configurable: true });
    await act(() => {
      fresh?.callback(
        [{ target: video, isIntersecting: false } as unknown as IntersectionObserverEntry],
        undefined as unknown as IntersectionObserver,
      );
    });

    expect(pause).not.toHaveBeenCalled();
  });

  it("pauses a video a scroll container clipped when fullscreen ended", async () => {
    const NativeIntersectionObserver = window.IntersectionObserver;
    const lastReports = new Map<Element, IntersectionObserverEntry>();
    class RecordingIntersectionObserver extends NativeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        super((entries, observer) => {
          for (const entry of entries) lastReports.set(entry.target, entry);
          callback(entries, observer);
        });
      }
    }
    using _observer = stubGlobal("IntersectionObserver", RecordingIntersectionObserver);
    // An empty source keeps the element from loading, so it stays mounted for the layout.
    await using screen = await render(
      <div
        data-testid="scroller"
        style={{ position: "relative", width: 414, height: 40, overflow: "hidden" }}
      >
        <MediaVideoPlayer src="" label="clip" style={{ position: "absolute", left: 0, top: 0 }} />
      </div>,
    );
    const scroller = screen.getByTestId("scroller").element().getBoundingClientRect();
    const video = screen.getByLabelText("clip").element() as HTMLVideoElement;
    using pause = vi.spyOn(video, "pause");

    // The video starts inside the box the container shows.
    await vi.waitFor(() => expect(lastReports.get(video)?.isIntersecting).toBe(true));
    expect(pause).not.toHaveBeenCalled();

    Object.defineProperty(video, "webkitDisplayingFullscreen", { value: true, configurable: true });

    // The container scrolls the video out of its box while the fullscreen player is up.
    video.style.top = "100px";
    const rect = video.getBoundingClientRect();
    // The video is inside the window, but outside the box the container shows.
    expect(rect.bottom).toBeLessThan(window.innerHeight);
    expect(rect.right).toBeLessThan(window.innerWidth);
    expect(rect.top).toBeGreaterThanOrEqual(scroller.bottom);

    // The clipped report arrives while the fullscreen player is up, so it is skipped.
    await vi.waitFor(() => expect(lastReports.get(video)?.isIntersecting).toBe(false));
    expect(pause).not.toHaveBeenCalled();

    Object.defineProperty(video, "webkitDisplayingFullscreen", {
      value: false,
      configurable: true,
    });
    await act(() => {
      video.dispatchEvent(new Event("webkitendfullscreen"));
    });

    await vi.waitFor(() => expect(pause).toHaveBeenCalled());
  });
});
