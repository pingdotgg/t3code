import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { MediaVideoPlayer } from "./MediaVideoPlayer";

// No video fixture is checked in, so record about a second of a solid color in the browser.
async function recordWebm(color: string): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  const stream = canvas.captureStream(0);
  const [track] = stream.getVideoTracks() as Array<CanvasCaptureMediaStreamTrack>;
  const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
  const chunks: Array<Blob> = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  recorder.start(100);
  // Each retry pushes one frame, so the clip grows until enough data has been recorded.
  await vi.waitFor(
    () => {
      context.fillRect(0, 0, 32, 32);
      track!.requestFrame();
      expect(chunks.length).toBeGreaterThanOrEqual(10);
    },
    { timeout: 5_000 },
  );
  const stopped = nextEvent(recorder, "stop");
  recorder.stop();
  await stopped;
  return new Blob(chunks, { type: "video/webm" });
}

function nextEvent(target: EventTarget, type: string): Promise<void> {
  return new Promise((resolve) => target.addEventListener(type, () => resolve(), { once: true }));
}

function videoElement(container: HTMLElement): HTMLVideoElement {
  const video = container.querySelector("video");
  if (!video) throw new Error("Expected a video element");
  return video;
}

describe("MediaVideoPlayer", () => {
  // regression: #23089 a paused preview reloaded to its first frame on every re-signed URL
  it("keeps a paused video's position across re-signed URLs until its revision changes", async () => {
    const original = await recordWebm("red");
    // Two object URLs for one blob stand in for re-signing an unchanged file.
    const signedUrl = URL.createObjectURL(original);
    const resignedUrl = URL.createObjectURL(original);
    const changedUrl = URL.createObjectURL(await recordWebm("blue"));
    const player = (src: string, revision: string) => (
      <MediaVideoPlayer src={src} label="clip.webm" revision={revision} preload="metadata" />
    );

    await using screen = await render(player(signedUrl, "content-1"));
    const video = videoElement(screen.container);
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) await nextEvent(video, "loadedmetadata");
    const seeked = nextEvent(video, "seeked");
    video.currentTime = 0.5;
    await seeked;

    await screen.rerender(player(resignedUrl, "content-1"));
    expect(videoElement(screen.container)).toBe(video);
    expect(video.getAttribute("src")).toBe(signedUrl);
    expect(video.currentTime).toBe(0.5);

    // An expired held URL falls back to the latest signature instead of failing.
    URL.revokeObjectURL(signedUrl);
    const failed = nextEvent(video, "error");
    await act(() => video.load());
    await failed;
    await expect.element(screen.getByLabelText("clip.webm")).toHaveAttribute("src", resignedUrl);
    expect(screen.container.querySelector("[role=alert]")).toBeNull();

    await screen.rerender(player(changedUrl, "content-2"));
    expect(videoElement(screen.container).getAttribute("src")).toBe(changedUrl);
  });
});
