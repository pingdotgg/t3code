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
});
