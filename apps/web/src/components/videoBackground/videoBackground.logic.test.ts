import { describe, expect, it } from "vite-plus/test";

import { videoBackgroundActive, videoFileUrl } from "./videoBackground.logic";

describe("video background", () => {
  it("is active for the galaxy, or for a chosen file on the desktop app", () => {
    const off = {
      videoBackground: "off",
      videoBackgroundFolder: "",
      videoBackgroundFile: "",
    } as const;
    expect(videoBackgroundActive(off, true)).toBe(false);
    expect(videoBackgroundActive({ ...off, videoBackground: "galaxy" }, false)).toBe(true);
    const file = {
      videoBackground: "file",
      videoBackgroundFolder: "/v",
      videoBackgroundFile: "a.mp4",
    } as const;
    expect(videoBackgroundActive(file, true)).toBe(true);
    expect(videoBackgroundActive(file, false)).toBe(false);
    expect(videoBackgroundActive({ ...file, videoBackgroundFile: "" }, true)).toBe(false);
  });

  it("builds the media URL for POSIX and Windows folders", () => {
    expect(videoFileUrl("t3code://app", "/home/me/videos", "space walk.mp4")).toBe(
      "t3code://app/__media/video?path=%2Fhome%2Fme%2Fvideos%2Fspace%20walk.mp4",
    );
    expect(videoFileUrl("t3code://app", "C:\\Videos\\", "a.mp4")).toBe(
      `t3code://app/__media/video?path=${encodeURIComponent("C:\\Videos\\a.mp4")}`,
    );
  });
});
