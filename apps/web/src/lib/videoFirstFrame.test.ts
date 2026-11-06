import { describe, expect, it } from "vite-plus/test";

import { prepareVideoFirstFrame } from "./videoFirstFrame";

type PreviewVideo = Parameters<typeof prepareVideoFirstFrame>[0];

function previewVideo(overrides: Partial<PreviewVideo> = {}): PreviewVideo {
  return {
    autoplay: false,
    paused: true,
    seeking: false,
    currentTime: 0,
    duration: 5,
    played: { length: 0, start: () => 0, end: () => 0 },
    src: "https://environment.test/api/assets/signed/video.mp4?signature=example",
    ...overrides,
  };
}

describe("prepareVideoFirstFrame", () => {
  it.each([
    ["video.mp4#t=0,4", 0],
    ["video.mp4#xywh=0,0,100,100&%74=3", 0],
    ["video%23t=3.mp4", 0.1],
  ])(
    "distinguishes temporal fragments from encoded filename hashes: %s",
    (path, expectedPosition) => {
      const video = previewVideo({ src: `https://environment.test/${path}` });

      prepareVideoFirstFrame(video);

      expect(video.currentTime).toBe(expectedPosition);
    },
  );
});
