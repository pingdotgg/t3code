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
    [5, 0.1],
    [0.05, 0.025],
  ])(
    "seeks within a %s second video only once when metadata repeats",
    (duration, expectedPosition) => {
      const video = previewVideo({ duration });
      const seeks: number[] = [];
      Object.defineProperty(video, "currentTime", {
        get: () => seeks.at(-1) ?? 0,
        set: (value: number) => seeks.push(value),
      });
      prepareVideoFirstFrame(video);
      prepareVideoFirstFrame(video);

      expect(seeks).toEqual([expectedPosition]);
    },
  );

  it.each<Partial<PreviewVideo>>([
    { autoplay: true },
    { paused: false },
    { seeking: true },
    { currentTime: 2 },
    { played: { length: 1, start: () => 0, end: () => 2 } },
    { duration: 0 },
    { duration: Number.POSITIVE_INFINITY },
  ])("does not seek over playback or unavailable metadata: %j", (state) => {
    const video = previewVideo(state);
    const position = video.currentTime;

    prepareVideoFirstFrame(video);

    expect(video.currentTime).toBe(position);
  });

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

  it("tolerates a browser rejecting the preview seek", () => {
    const video = previewVideo();
    Object.defineProperty(video, "currentTime", {
      get: () => 0,
      set: () => {
        throw new Error("The stream is not seekable yet");
      },
    });

    expect(() => prepareVideoFirstFrame(video)).not.toThrow();
  });
});
