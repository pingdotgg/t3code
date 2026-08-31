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

  it.each(["README", "report.pdf", "file.constructor", "file.__proto__"])(
    "does not mistake %s for a video",
    (name) => {
      expect(videoMimeType({ name, mimeType: "application/octet-stream" })).toBeNull();
    },
  );
});
