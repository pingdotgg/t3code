import { describe, expect, it } from "vite-plus/test";

import { videoMimeType } from "./video.ts";

describe("videoMimeType", () => {
  it("recognizes a saved video with a generic picker MIME type", () => {
    expect(videoMimeType({ name: "Recording.MOV", mimeType: "application/octet-stream" })).toBe(
      "video/quicktime",
    );
  });

  it("keeps an explicit video MIME type authoritative and removes parameters", () => {
    expect(videoMimeType({ name: "recording.mp4", mimeType: " VIDEO/WebM; codecs=vp9 " })).toBe(
      "video/webm",
    );
  });

  it("recognizes MPEG transport-stream recordings without treating TypeScript files as video", () => {
    expect(videoMimeType({ name: "clamp.ts", mimeType: "video/mp2t" })).toBeNull();
    expect(videoMimeType({ name: "clamp.ts", mimeType: "video/vnd.dlna.mpeg-tts" })).toBeNull();
    expect(videoMimeType({ name: "clamp.mts", mimeType: "video/mp2t" })).toBeNull();
    expect(videoMimeType({ name: "recording.m2t", mimeType: "video/mp2t" })).toBe("video/mp2t");
    expect(videoMimeType({ name: "clip.m2ts", mimeType: "video/mp2t" })).toBe("video/mp2t");
    expect(videoMimeType({ name: "recording.m2t", mimeType: "video/vnd.dlna.mpeg-tts" })).toBe(
      "video/mp2t",
    );
  });
});
