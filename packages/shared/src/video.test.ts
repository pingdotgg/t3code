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

  it("does not treat a TypeScript file the OS labels as MPEG transport stream as video", () => {
    expect(videoMimeType({ name: "clamp.ts", mimeType: "video/mp2t" })).toBeNull();
    expect(videoMimeType({ name: "clamp.ts", mimeType: "video/vnd.dlna.mpeg-tts" })).toBeNull();
  });
});
