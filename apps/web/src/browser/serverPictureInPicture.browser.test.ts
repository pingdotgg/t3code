import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ readAccess: vi.fn() }));

vi.mock(import("~/state/previewStream"), () => ({
  readPreviewStreamAccess: mocks.readAccess,
}));

import { closeServerPictureInPicture, openServerPictureInPicture } from "./serverPictureInPicture";

function setup() {
  return {
    [Symbol.dispose]() {
      closeServerPictureInPicture();
      mocks.readAccess.mockReset();
    },
  };
}

it("cancels pending playback without reporting a failed popout", async () => {
  using _cleanup = setup();
  const opening = openServerPictureInPicture({
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    tabId: "tab",
    seed: null,
  });
  const video = document.querySelector("video")!;
  const tracks = (video.srcObject as MediaStream).getTracks();
  closeServerPictureInPicture();
  await expect(opening).resolves.toBeUndefined();
  expect(video.isConnected).toBe(false);
  expect(tracks.length).toBeGreaterThan(0);
  expect(tracks.every((track) => track.readyState === "ended")).toBe(true);
  expect(mocks.readAccess).not.toHaveBeenCalled();
});

it("still reports playback failures for an active popout", async () => {
  using _cleanup = setup();
  const error = new Error("Playback failed");
  using _play = vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(error);
  const opening = openServerPictureInPicture({
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    tabId: "tab",
    seed: null,
  });
  const video = document.querySelector("video")!;
  const tracks = (video.srcObject as MediaStream).getTracks();
  await expect(opening).rejects.toBe(error);
  expect(video.isConnected).toBe(false);
  expect(tracks.every((track) => track.readyState === "ended")).toBe(true);
  expect(mocks.readAccess).not.toHaveBeenCalled();
});
