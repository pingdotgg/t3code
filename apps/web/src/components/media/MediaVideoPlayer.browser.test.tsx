import { describe, expect, it } from "vite-plus/test";

import { act, render, stubGlobal, type Screen } from "../../../test/render";
import { MediaVideoPlayer } from "./MediaVideoPlayer";

// The observer never reports the video as visible, so it keeps preload="none" and never
// requests these fake URLs; the test fires the media events itself.
class HiddenIntersectionObserver {
  observe() {}
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
});
